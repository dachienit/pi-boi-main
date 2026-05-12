/**
 * Path resolver for DIA Brain canonical responses.
 *
 * DIA is workspace-blind: it returns simple basenames (e.g. `z_hello.abap`),
 * never paths. Pi-boi is the only component that knows the real filesystem
 * layout (`<workspace>/sessions/<channelId>/scratch/`, `<workspace>/artifacts/<channelId>/`).
 *
 * These helpers sanitize the basename DIA returned and expand it to an absolute
 * path in the right session directory. They also enforce hard rejections for
 * any path-traversal attempt — DIA must NEVER be able to write outside its
 * session sandbox, even if a malicious or buggy response slips through.
 */

import { basename, isAbsolute, join } from "path";

/**
 * Sanitize a basename received from DIA.
 *
 * Rules (any failure throws):
 * - Must be a non-empty string after trimming.
 * - Must NOT contain path separators (we strip them via `path.basename` first
 *   and reject if the result differs from the input — meaning DIA tried to
 *   send a path).
 * - Must NOT be `.` or `..`.
 * - Must NOT be an absolute path (Windows drive letter or POSIX root).
 * - Must NOT contain null bytes (defensive against C-style payloads).
 *
 * @param raw The raw `file_name` field DIA returned.
 * @param fieldLabel Used in the error message (e.g. "file_name" / "html_artifact basename").
 * @returns The sanitized basename, safe to join under a known session directory.
 */
export function sanitizeBasename(raw: unknown, fieldLabel: string): string {
	if (typeof raw !== "string") {
		throw new Error(`Invalid ${fieldLabel} from DIA: expected string, got ${typeof raw}`);
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error(`Invalid ${fieldLabel} from DIA: empty string`);
	}
	if (trimmed.includes("\0")) {
		throw new Error(`Invalid ${fieldLabel} from DIA: null byte rejected`);
	}
	if (isAbsolute(trimmed)) {
		throw new Error(`Invalid ${fieldLabel} from DIA: absolute path rejected (${trimmed})`);
	}
	// Windows drive letter (covers e.g. C:foo even when not a full absolute path).
	if (/^[A-Za-z]:/.test(trimmed)) {
		throw new Error(`Invalid ${fieldLabel} from DIA: drive letter rejected (${trimmed})`);
	}

	const stripped = basename(trimmed);
	if (stripped !== trimmed) {
		throw new Error(
			`Invalid ${fieldLabel} from DIA: directory components rejected (${trimmed} → ${stripped})`,
		);
	}
	if (stripped === "." || stripped === "..") {
		throw new Error(`Invalid ${fieldLabel} from DIA: '.' / '..' rejected`);
	}
	return stripped;
}

/**
 * Resolve a DIA-provided basename to an absolute path under the session scratch
 * directory: `<workspaceDir>/sessions/<channelId>/scratch/<sanitized>`.
 */
export function resolveCanonicalFileName(
	basenameRaw: unknown,
	channelId: string,
	workspaceDir: string,
): string {
	const safe = sanitizeBasename(basenameRaw, "file_name");
	return join(workspaceDir, "sessions", channelId, "scratch", safe);
}

/**
 * Resolve a DIA-provided basename for an HTML artifact under
 * `<workspaceDir>/artifacts/<channelId>/<basename>`. If DIA omitted the
 * basename, we auto-generate a timestamp-based one.
 */
export function resolveCanonicalArtifactName(
	basenameRaw: unknown,
	channelId: string,
	workspaceDir: string,
): string {
	const safe =
		basenameRaw === undefined || basenameRaw === null || basenameRaw === ""
			? `artifact-${Date.now()}.html`
			: sanitizeBasename(basenameRaw, "html_artifact basename");
	return join(workspaceDir, "artifacts", channelId, safe);
}
