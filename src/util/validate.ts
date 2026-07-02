/**
 * Shared validators for values derived from untrusted card/issue text before
 * they reach git/gh.
 */

// Branch/ref shape allowed to reach git/gh. Must start alphanumeric (blocks
// `-flag` argv confusion) and contain only safe ref chars (blocks the ` ; | $`
// backtick etc. of an injection payload). Combined with execFile/argv (no
// shell), issue text can never reach a shell.
//
// NOTE: issue #188 literally specifies `^[a-z0-9-]{1,60}$`, but that rejects the
// `/` in the very branch format the skill generates (`feat/issue-N-slug`) —
// following it verbatim would break the pipeline. This is the corrected intent.
export const BRANCH_RE = /^[a-z0-9][a-z0-9._/-]{0,59}$/;

export const isValidBranch = (branch: string): boolean => BRANCH_RE.test(branch);
