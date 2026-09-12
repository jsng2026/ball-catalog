"use strict";
async function commitFilesAtomically(gh, repo, branch, expectedHead, changes) {
  const root = `/repos/${repo}/git`;
  const current = await gh(`${root}/ref/heads/${branch}`);
  if (current.object.sha !== expectedHead) throw new Error("Repository changed. Reload before saving; your edits have not been committed.");
  const commit = await gh(`${root}/commits/${expectedHead}`);
  const tree = await gh(`${root}/trees`, { method: "POST", body: JSON.stringify({
    base_tree: commit.tree.sha,
    tree: changes.map(change => ({ path: change.path, mode: "100644", type: "blob", content: JSON.stringify(change.json, null, 2) + "\n" }))
  }) });
  const next = await gh(`${root}/commits`, { method: "POST", body: JSON.stringify({
    message: "Admin panel: update catalog inputs", tree: tree.sha, parents: [expectedHead]
  }) });
  // A concurrent commit makes this non-fast-forward and GitHub rejects it.
  await gh(`${root}/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: next.sha, force: false }) });
  return next.sha;
}
