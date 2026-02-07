const core = require("@actions/core");
const github = require("@actions/github");

// -------- helpers --------

function toBool(s, def = false) {
  if (s == null) return def;
  const v = String(s).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return def;
}

function clampInt(s, def, min, max) {
  const n = parseInt(String(s ?? def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function escapeMd(s) {
  return String(s ?? "").replace(/\r?\n/g, " ").trim();
}

const DEFAULT_LABEL_MAP = {
  "bug": "Fixed", "fix": "Fixed", "bugfix": "Fixed",
  "enhancement": "Added", "feat": "Added", "feature": "Added",
  "chore": "Changed", "refactor": "Changed", "deps": "Changed", "dependencies": "Changed",
  "docs": "Docs", "documentation": "Docs"
};

const CONVENTIONAL_PREFIX_MAP = {
  "feat": "Added",
  "fix": "Fixed",
  "chore": "Changed",
  "refactor": "Changed",
  "docs": "Docs"
};

const DEPS_LABELS = new Set(["dependencies", "deps", "dependabot"]);

function bucketForLabels(labelNames, sectionMap) {
  const names = (labelNames || []).map((l) => String(l).toLowerCase());
  for (const name of names) {
    if (sectionMap[name]) return sectionMap[name];
  }
  return "Other";
}

function bucketFromConventionalTitle(title) {
  const match = (title || "").match(/^(\w+)(?:\(.+?\))?:\s*/);
  if (!match) return null;
  return CONVENTIONAL_PREFIX_MAP[match[1].toLowerCase()] || null;
}

function parseCommaSeparated(s) {
  return (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function shouldExcludePR(pr, { includeLabels, excludeLabels, ignoreDeps }) {
  const labels = (pr.labels || []).map((l) => String(l).toLowerCase());

  if (ignoreDeps && labels.length > 0 && labels.every((l) => DEPS_LABELS.has(l))) {
    return true;
  }

  if (excludeLabels.length > 0 && labels.some((l) => excludeLabels.includes(l))) {
    return true;
  }

  if (includeLabels.length > 0 && !labels.some((l) => includeLabels.includes(l))) {
    return true;
  }

  return false;
}

function formatLine(pr) {
  const title = escapeMd(pr.title);
  const num = pr.number;
  const author = pr.user;
  return `- ${title} (#${num}) @${author}`;
}

async function writeSummary(md) {
  await core.summary.addRaw(md).addEOL().write();
}

// -------- GitHub API helpers --------

async function listTagsAll(octokit, owner, repo, max = 200) {
  // listTags is ordered by most recent (by commit date-ish), usually.
  const out = [];
  let page = 1;
  while (out.length < max) {
    const resp = await octokit.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
      page
    });
    if (!resp.data.length) break;
    out.push(...resp.data);
    if (resp.data.length < 100) break;
    page++;
  }
  return out.slice(0, max);
}

async function tagCommitDateISO(octokit, owner, repo, tagName) {
  // Resolve refs/tags/<tag> -> object sha -> commit date
  // Note: tag may point to annotated tag or commit; handle both.
  const refResp = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `tags/${tagName}`
  });

  let sha = refResp.data.object.sha;
  let type = refResp.data.object.type;

  if (type === "tag") {
    // annotated tag -> resolve to target
    const tagObj = await octokit.rest.git.getTag({ owner, repo, tag_sha: sha });
    sha = tagObj.data.object.sha;
    type = tagObj.data.object.type;
  }

  if (type !== "commit") {
    // best effort fallback
    const commit = await octokit.rest.repos.getCommit({ owner, repo, ref: sha });
    const dt = commit.data.commit?.committer?.date || commit.data.commit?.author?.date;
    if (!dt) throw new Error(`Unable to determine commit date for tag ${tagName}`);
    return dt;
  }

  const commit = await octokit.rest.repos.getCommit({ owner, repo, ref: sha });
  const dt = commit.data.commit?.committer?.date || commit.data.commit?.author?.date;
  if (!dt) throw new Error(`Unable to determine commit date for tag ${tagName}`);
  return dt;
}

async function searchMergedPRs(octokit, { owner, repo, baseBranch, mergedAfterISO, maxPRs }) {
  // Use Search API. It returns issues+prs; items include title/number/user/labels (usually).
  // Query example:
  // repo:owner/repo is:pr is:merged base:main merged:>2025-01-01T00:00:00Z
  const q = `repo:${owner}/${repo} is:pr is:merged base:${baseBranch} merged:>${mergedAfterISO}`;

  const perPage = 100;
  const out = [];
  let page = 1;

  while (out.length < maxPRs) {
    const resp = await octokit.rest.search.issuesAndPullRequests({
      q,
      sort: "updated",
      order: "desc",
      per_page: perPage,
      page
    });

    if (!resp.data.items.length) break;

    for (const item of resp.data.items) {
      // item.pull_request exists for PRs; but search filters is:pr so okay
      const labels = Array.isArray(item.labels)
        ? item.labels
            .map((l) => (typeof l === "string" ? l : l?.name))
            .filter(Boolean)
        : [];

      out.push({
        number: item.number,
        title: item.title,
        user: item.user?.login || "unknown",
        labels
      });

      if (out.length >= maxPRs) break;
    }

    if (resp.data.items.length < perPage) break;
    page++;
  }

  // Sort stable-ish by PR number ascending for nicer reading
  out.sort((a, b) => a.number - b.number);
  return out;
}

async function upsertReleaseByTag(octokit, { owner, repo, tag, body, draft }) {
  try {
    const existing = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
    const updated = await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: existing.data.id,
      body,
      draft
    });
    return { action: "updated", url: updated.data.html_url };
  } catch (e) {
    // If not found, create
    const created = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: `Release ${tag}`,
      body,
      draft
    });
    return { action: "created", url: created.data.html_url };
  }
}

const PREVIEW_MARKER = "<!-- release-notes-preview:v0 -->";

async function upsertComment(octokit, { owner, repo, issue_number, body }) {
  const comments = await octokit.rest.issues.listComments({
    owner, repo, issue_number, per_page: 100
  });
  const existing = comments.data.find((c) => (c.body || "").includes(PREVIEW_MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return { updated: true, url: existing.html_url };
  }
  const created = await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
  return { updated: false, url: created.data.html_url };
}

// -------- main --------

async function run() {
  try {
    const token = core.getInput("github_token", { required: true });
    const baseBranch = core.getInput("base_branch") || "main";
    const createRelease = toBool(core.getInput("create_release"), true);
    const draft = toBool(core.getInput("draft"), true);
    const sinceDays = clampInt(core.getInput("since_days"), 30, 1, 3650);
    const maxPRs = clampInt(core.getInput("max_prs"), 200, 1, 1000);
    const excludeLabels = parseCommaSeparated(core.getInput("exclude_labels"));
    const includeLabels = parseCommaSeparated(core.getInput("include_labels"));
    const ignoreDeps = toBool(core.getInput("ignore_deps"), false);
    const useConventional = toBool(core.getInput("use_conventional_commits"), false);
    const previewOnPR = toBool(core.getInput("preview_on_pr"), false);

    let sectionMap = DEFAULT_LABEL_MAP;
    const sectionMapRaw = core.getInput("section_map") || "";
    if (sectionMapRaw) {
      try {
        sectionMap = JSON.parse(sectionMapRaw);
      } catch {
        core.warning("Could not parse section_map as JSON; using defaults.");
      }
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const eventName = github.context.eventName;
    const refType = github.context.refType; // "tag" on tag push (when available)
    const refName = github.context.refName; // tag name or branch name

    let currentTag = null;
    let previousTag = null;
    let baselineISO = null;

    // Determine current tag if triggered by tag push
    if (eventName === "push" && (refType === "tag" || (github.context.ref || "").startsWith("refs/tags/"))) {
      currentTag = refName || (github.context.ref || "").replace("refs/tags/", "");
    }

    const tags = await listTagsAll(octokit, owner, repo, 200);

    if (currentTag) {
      const idx = tags.findIndex((t) => t.name === currentTag);
      if (idx === -1) {
        core.warning(`Current tag ${currentTag} not found in listTags; falling back to latest tag logic.`);
      } else {
        if (idx + 1 < tags.length) previousTag = tags[idx + 1].name;
      }

      if (previousTag) {
        baselineISO = await tagCommitDateISO(octokit, owner, repo, previousTag);
      } else {
        // no previous tag: fallback to since_days
        baselineISO = isoDaysAgo(sinceDays);
      }
    } else {
      // Manual / non-tag run: latest tag as "current", previous as baseline if available
      if (tags.length >= 2) {
        currentTag = tags[0].name;
        previousTag = tags[1].name;
        baselineISO = await tagCommitDateISO(octokit, owner, repo, currentTag); // latest tag time as baseline
      } else if (tags.length === 1) {
        currentTag = tags[0].name;
        baselineISO = await tagCommitDateISO(octokit, owner, repo, currentTag);
      } else {
        baselineISO = isoDaysAgo(sinceDays);
      }
    }

    core.info(`Base branch: ${baseBranch}`);
    core.info(`Current tag: ${currentTag || "(none)"}`);
    core.info(`Previous tag: ${previousTag || "(none)"}`);
    core.info(`Merged-after baseline: ${baselineISO}`);

    const prs = await searchMergedPRs(octokit, {
      owner,
      repo,
      baseBranch,
      mergedAfterISO: baselineISO,
      maxPRs
    });

    const filtered = prs.filter((pr) => !shouldExcludePR(pr, { includeLabels, excludeLabels, ignoreDeps }));

    // Group PRs
    const buckets = new Map([
      ["Added", []],
      ["Fixed", []],
      ["Changed", []],
      ["Docs", []],
      ["Other", []]
    ]);

    for (const pr of filtered) {
      let b = bucketForLabels(pr.labels, sectionMap);
      if (b === "Other" && useConventional) {
        b = bucketFromConventionalTitle(pr.title) || "Other";
      }
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(pr);
    }

    const title =
      eventName === "push" && currentTag
        ? `## Release ${currentTag}`
        : `## Release notes (unreleased)`;

    const rangeLine =
      currentTag && previousTag
        ? `From **${previousTag}** to **${currentTag}**`
        : currentTag
        ? `Since tag **${currentTag}**`
        : `Since **${baselineISO}**`;

    let body = `${title}\n\n${rangeLine}\n`;

    if (currentTag && previousTag) {
      body += `[Full diff](https://github.com/${owner}/${repo}/compare/${previousTag}...${currentTag})\n`;
    }
    body += `\n`;

    const order = ["Added", "Fixed", "Changed", "Docs", "Other"];
    let total = 0;

    for (const k of order) {
      const items = buckets.get(k) || [];
      if (!items.length) continue;
      total += items.length;
      body += `### ${k}\n`;
      for (const pr of items) body += `${formatLine(pr)}\n`;
      body += `\n`;
    }

    if (total === 0) {
      body += `_No merged PRs found in this range._\n`;
    }

    // Always write summary
    await writeSummary(body);

    // Optionally create/update release (only makes sense on tag runs)
    if (createRelease) {
      if (eventName === "push" && currentTag) {
        const res = await upsertReleaseByTag(octokit, {
          owner,
          repo,
          tag: currentTag,
          body,
          draft
        });
        core.info(`Release ${res.action}: ${res.url}`);
        await writeSummary(`\n---\n${draft ? "Draft release" : "Release"} ${res.action}: ${res.url}\n`);
      } else {
        core.info("create_release=true but this is not a tag push; skipping GitHub Release creation.");
        await writeSummary(`\n---\nRelease creation skipped (not a tag push).\n`);
      }
    }

    // Preview comment on PRs (feature 5.7)
    if (previewOnPR && eventName === "pull_request") {
      const prNumber = github.context.payload?.pull_request?.number;
      if (prNumber) {
        const prData = github.context.payload.pull_request;
        const prLabels = (prData.labels || []).map((l) => l.name || l);
        let section = bucketForLabels(prLabels, sectionMap);
        if (section === "Other" && useConventional) {
          section = bucketFromConventionalTitle(prData.title) || "Other";
        }
        const previewBody =
          `### Release Notes Preview\n${PREVIEW_MARKER}\n\n` +
          `This PR will appear in section: **${section}**\n\n` +
          `Sample entry:\n` +
          `${formatLine({ title: prData.title, number: prNumber, user: prData.user?.login || "unknown" })}\n`;
        const c = await upsertComment(octokit, { owner, repo, issue_number: prNumber, body: previewBody });
        core.info(`Preview comment ${c.updated ? "updated" : "created"}: ${c.url}`);
      }
    }
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
}

run();