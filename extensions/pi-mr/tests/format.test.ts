// Pure-logic tests for pi-mr's status line renderer.
// Run: npm run test:mr
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MrInfo } from "../forge.ts";
import { renderMrLine, type ColorRole } from "../format.ts";

const color = (role: ColorRole, text: string) => `<${role}>${text}</${role}>`;

function stripLink(text: string): string {
	return text.replace(/\x1b]8;;[^\x1b]*\x1b\\/g, "");
}

function info(overrides: Partial<MrInfo> = {}): MrInfo {
	return {
		forge: "gitlab",
		ref: "!1234",
		title: "登录改造",
		state: "opened",
		ci: "success",
		conflicts: false,
		url: "https://git.maxjia.com/sunlinhao/rcman/-/merge_requests/1234",
		...overrides,
	};
}

test("renderMrLine: open request with green CI", () => {
	assert.equal(stripLink(renderMrLine(info(), color)), "<success>⬤</success> <accent>!1234</accent> <success>✓CI</success> <muted>登录改造</muted>");
});

test("renderMrLine: state icons and colors", () => {
	assert.match(stripLink(renderMrLine(info({ state: "draft" }), color)), /^<dim>◌<\/dim>/);
	assert.match(stripLink(renderMrLine(info({ state: "merged" }), color)), /^<accent>✔<\/accent>/);
	assert.match(stripLink(renderMrLine(info({ state: "closed" }), color)), /^<error>✕<\/error>/);
});

test("renderMrLine: CI tokens, including none being omitted", () => {
	assert.match(renderMrLine(info({ ci: "failed" }), color), /<error>✗CI<\/error>/);
	assert.match(renderMrLine(info({ ci: "running" }), color), /<warning>⋯CI<\/warning>/);
	const none = stripLink(renderMrLine(info({ ci: "none" }), color));
	assert.ok(!none.includes("CI"), none);
	assert.equal(none, "<success>⬤</success> <accent>!1234</accent> <muted>登录改造</muted>");
});

test("renderMrLine: conflicts badge only when flagged", () => {
	assert.match(stripLink(renderMrLine(info({ conflicts: true }), color)), /<warning>⚠冲突<\/warning>/);
	assert.ok(!stripLink(renderMrLine(info({ conflicts: false }), color)).includes("⚠冲突"));
});

test("renderMrLine: ref links to the request, and survives a missing title/url", () => {
	assert.ok(renderMrLine(info(), color).includes("\x1b]8;;https://git.maxjia.com/sunlinhao/rcman/-/merge_requests/1234\x1b\\"));
	assert.equal(stripLink(renderMrLine(info({ url: "", title: "" }), color)), "<success>⬤</success> <accent>!1234</accent> <success>✓CI</success>");
	// GitHub refs keep their `#` form.
	assert.match(stripLink(renderMrLine(info({ forge: "github", ref: "#42" }), color)), /<accent>#42<\/accent>/);
});
