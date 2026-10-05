/**
 * GitHub Export
 * -------------
 * Exports a Velbaz project (all its persisted `projectFiles`) to GitHub as a
 * PRIVATE repository, in a single commit, using the GitHub Git Data API.
 *
 * Configuration (the system is fully implemented and only WAITS for the key):
 *   - GITHUB_TOKEN  (required)  RECOMMENDED: a CLASSIC Personal Access Token
 *                              (ghp_…) with the `repo` scope. A fine-grained
 *                              token (github_pat_…) also works only with
 *                              Repository access = All repositories AND
 *                              "Administration: Read and write" +
 *                              "Contents: Read and write".
 *                              Without it, export returns { error: "github_not_configured" }.
 *   - GITHUB_OWNER  (optional) Create the repo under this org/user instead of
 *                              the token owner's personal account.
 *
 * Nothing else is needed — as soon as GITHUB_TOKEN is present in the env, the
 * "Export to GitHub" button works end-to-end.
 */

const GH_API = "https://api.github.com";

import { getSecret } from '../secret-store';

export type ExportFile = { path: string; content: string };

export type ExportResult =
  | { ok: true; repoUrl: string; repoFullName: string; branch: string; created: boolean; fileCount: number }
  | { ok: false; error: string; detail?: string };

/** Whether a GitHub token is configured. UI uses this to know if it can export. */
export function isGithubConfigured(): boolean {
  return !!(getSecret('GITHUB_TOKEN') && getSecret('GITHUB_TOKEN').trim());
}

/** Turn any project name into a valid GitHub repo slug. */
export function toRepoName(name: string): string {
  const slug = (name || "velbaz-project")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")        // strip accents
    .replace(/[^a-z0-9._-]+/g, "-")          // valid chars only
    .replace(/^-+|-+$/g, "")                 // trim dashes
    .replace(/-{2,}/g, "-")                  // collapse dashes
    .slice(0, 90);
  return slug || "velbaz-project";
}

async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "Velbaz-Exporter",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json, headers: res.headers };
}

/** Classic tokens start with ghp_, fine-grained ones with github_pat_. */
export function githubTokenKind(token: string): "classic" | "fine-grained" | "other" {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "other";
}

/**
 * Human (French) explanation for a 403 from GitHub, telling the user exactly
 * which token to create. GitHub sends `x-accepted-github-permissions` on
 * fine-grained 403s, which we surface verbatim.
 */
export function githubForbiddenHelp(token: string, step: string, headers?: Headers, message?: string): string {
  const kind = githubTokenKind(token);
  const needed = headers?.get("x-accepted-github-permissions") || "";
  const base = `GitHub a refusé l'action « ${step} » (403${message ? ` : ${message}` : ""}).`;
  const fix =
    kind === "fine-grained"
      ? " Ton jeton est un jeton « fine-grained » sans droit d'écriture. Le plus simple : crée un jeton CLASSIQUE (github.com/settings/tokens → Generate new token (classic)) avec la case « repo » cochée, puis remplace GITHUB_TOKEN dans Admin → Clés API. Sinon, sur ton jeton fine-grained : Repository access = All repositories, et Permissions → Administration : Read and write + Contents : Read and write."
      : kind === "classic"
        ? " Ton jeton classique n'a pas le droit « repo ». Recrée-le sur github.com/settings/tokens avec la case « repo » cochée, puis remplace GITHUB_TOKEN dans Admin → Clés API."
        : " Utilise un jeton CLASSIQUE (ghp_…) avec la case « repo » cochée, puis remplace GITHUB_TOKEN dans Admin → Clés API.";
  return base + fix + (needed ? ` (Permission demandée par GitHub : ${needed})` : "");
}

/**
 * Export the given files to a private GitHub repository named `repoName`.
 * Creates the repo if it doesn't exist, then pushes all files as one commit on
 * `main` (force-updating if the repo already had content). Returns the repo URL.
 */
export async function exportToGithub(
  repoName: string,
  files: ExportFile[],
  opts: { description?: string; commitMessage?: string } = {},
): Promise<ExportResult> {
  const token = (getSecret('GITHUB_TOKEN') || "").trim();
  if (!token) return { ok: false, error: "github_not_configured" };

  const cleanFiles = files.filter((f) => f && f.path && typeof f.content === "string");
  if (cleanFiles.length === 0) return { ok: false, error: "no_files" };

  // 1) Resolve owner (org from env, else the token's user).
  let owner = (getSecret('GITHUB_OWNER') || "").trim();
  if (!owner) {
    const me = await gh(token, "GET", "/user");
    if (me.status === 401) return { ok: false, error: "github_bad_token", detail: "Token rejected (401)." };
    if (me.status >= 400 || !me.json?.login) {
      return { ok: false, error: "github_error", detail: `GET /user → ${me.status}` };
    }
    owner = me.json.login;
  }

  const repo = toRepoName(repoName);

  // 2) Ensure the repo exists (private). Create it if missing.
  let created = false;
  let createdBranch = "";
  const existing = await gh(token, "GET", `/repos/${owner}/${repo}`);
  if (existing.status === 404) {
    // Create under org if GITHUB_OWNER is an org, else under the authed user.
    const createUnderOrg = !!(getSecret('GITHUB_OWNER') || "").trim();
    const createPath = createUnderOrg ? `/orgs/${owner}/repos` : `/user/repos`;
    const create = await gh(token, "POST", createPath, {
      name: repo,
      private: true,               // ← always a PRIVATE repository
      description: opts.description || "Exported from Velbaz",
      // auto_init creates a first commit: the Git Data API (blobs/trees)
      // refuses to work on a completely empty repository (409).
      auto_init: true,
    });
    if (create.status === 403 || create.status === 404) {
      return {
        ok: false,
        error: "github_forbidden",
        detail: githubForbiddenHelp(token, "créer le dépôt", create.headers, create.json?.message),
      };
    }
    if (create.status >= 400) {
      return {
        ok: false,
        error: "github_create_failed",
        detail: `POST ${createPath} → ${create.status} ${create.json?.message || ""}`.trim(),
      };
    }
    created = true;
    createdBranch = String(create.json?.default_branch || "");
  } else if (existing.status === 403) {
    return { ok: false, error: "github_forbidden", detail: githubForbiddenHelp(token, "lire le dépôt", existing.headers, existing.json?.message) };
  } else if (existing.status === 401) {
    return { ok: false, error: "github_bad_token", detail: "Token rejected (401)." };
  } else if (existing.status >= 400) {
    return { ok: false, error: "github_error", detail: `GET /repos → ${existing.status}` };
  }

  const repoFullName = `${owner}/${repo}`;
  const repoUrl = `https://github.com/${repoFullName}`;
  const branch = (created ? createdBranch : existing.json?.default_branch) || "main";

  // A repo with zero commits can't take blobs (409 "Git Repository is empty").
  // Seed it with one file through the Contents API so the Git Data API works.
  const ensureNotEmpty = async (): Promise<ExportResult | null> => {
    for (let i = 0; i < 6; i++) {
      const r = await gh(token, "GET", `/repos/${repoFullName}/git/ref/heads/${branch}`);
      if (r.status === 200) return null;
      if (created && i < 5) { await new Promise((ok) => setTimeout(ok, 800)); continue; }
      break;
    }
    const seed = await gh(token, "PUT", `/repos/${repoFullName}/contents/README.md`, {
      message: "Init from Velbaz",
      content: Buffer.from(`# ${repo}\n\nExported from Velbaz.\n`, "utf8").toString("base64"),
      branch,
    });
    if (seed.status === 403 || seed.status === 404) {
      return { ok: false, error: "github_forbidden", detail: githubForbiddenHelp(token, "écrire des fichiers", seed.headers, seed.json?.message) };
    }
    if (seed.status >= 400 && seed.status !== 422) {
      return { ok: false, error: "github_error", detail: `init README → ${seed.status} ${seed.json?.message || ""}`.trim() };
    }
    return null;
  };
  const seedErr = await ensureNotEmpty();
  if (seedErr) return seedErr;

  // 3) Create a blob for each file (base64 keeps binary/UTF-8 safe).
  const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const f of cleanFiles) {
    const contentB64 = Buffer.from(f.content, "utf8").toString("base64");
    const blob = await gh(token, "POST", `/repos/${repoFullName}/git/blobs`, {
      content: contentB64,
      encoding: "base64",
    });
    if (blob.status === 403 || blob.status === 404) {
      return { ok: false, error: "github_forbidden", detail: githubForbiddenHelp(token, "écrire des fichiers", blob.headers, blob.json?.message) };
    }
    if (blob.status >= 400 || !blob.json?.sha) {
      return { ok: false, error: "github_blob_failed", detail: `blob ${f.path} → ${blob.status} ${blob.json?.message || ""}`.trim() };
    }
    tree.push({ path: f.path.replace(/^\/+/, ""), mode: "100644", type: "blob", sha: blob.json.sha });
  }

  // 4) Find the current branch head (if the repo already had commits).
  let parentSha: string | null = null;
  const ref = await gh(token, "GET", `/repos/${repoFullName}/git/ref/heads/${branch}`);
  if (ref.status === 200 && ref.json?.object?.sha) parentSha = ref.json.object.sha;

  // 5) Build the tree, commit, and move the branch pointer.
  const treeRes = await gh(token, "POST", `/repos/${repoFullName}/git/trees`, { tree });
  if (treeRes.status >= 400 || !treeRes.json?.sha) {
    return { ok: false, error: "github_tree_failed", detail: `tree → ${treeRes.status} ${treeRes.json?.message || ""}` };
  }

  const commitRes = await gh(token, "POST", `/repos/${repoFullName}/git/commits`, {
    message: opts.commitMessage || "Export from Velbaz",
    tree: treeRes.json.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (commitRes.status >= 400 || !commitRes.json?.sha) {
    return { ok: false, error: "github_commit_failed", detail: `commit → ${commitRes.status}` };
  }
  const commitSha = commitRes.json.sha;

  if (parentSha) {
    const upd = await gh(token, "PATCH", `/repos/${repoFullName}/git/refs/heads/${branch}`, {
      sha: commitSha,
      force: true,
    });
    if (upd.status >= 400) {
      return { ok: false, error: "github_ref_failed", detail: `update ref → ${upd.status}` };
    }
  } else {
    const mk = await gh(token, "POST", `/repos/${repoFullName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
    if (mk.status >= 400) {
      return { ok: false, error: "github_ref_failed", detail: `create ref → ${mk.status} ${mk.json?.message || ""}` };
    }
  }

  return { ok: true, repoUrl, repoFullName, branch, created, fileCount: cleanFiles.length };
}
