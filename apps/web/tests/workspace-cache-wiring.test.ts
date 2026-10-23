import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const text = readFileSync(new URL("../src/ui/procurement-workspace.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("workspace.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function definition(name: string): string {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source); assert(found, `${name} must remain connected to the workspace`);
  return found.getText(source);
}

test("workspace navigation actually consumes the cache instead of merely shipping an unused helper", () => {
  for (const name of ["refreshProjects", "restoreLocation"]) assert(definition(name).includes("readWorkbookList<"), name);
  assert(definition("navigate").includes("!canRestoreWithoutLoading(next)"));
  assert(definition("updateFilters").includes("!canRestoreWithoutLoading(updated)"));
  assert(definition("task").includes("setBusy(blocking)"));
  assert(!text.includes("api<AnalysisPage>"), "list reads must not bypass cache/deduplication");
  for (const name of ["performSave", "persistAnalysisMetadata", "confirmRemoveAnalysis", "confirmRemoveProject"]) {
    const body = definition(name);
    assert(body.indexOf("await api") >= 0, name);
    assert(body.indexOf("invalidateWorkbookLists") > body.indexOf("await api"), `${name}: invalidate only after server confirmation`);
  }
});

test("project intent prefetch is delayed, cancellable, metadata-only and wired to mouse and keyboard", () => {
  const body = definition("prefetchProject");
  assert(body.includes("}, 150)"));
  assert(body.includes("prefetchWorkbookList(actorId, analysisListUrl(next))"));
  assert(body.includes("workspaceEpoch.current !== epoch"));
  assert(body.includes("lastActor.current !== actorId"));
  assert(definition("cancelProjectPrefetch").includes("clearTimeout"));
  assert(text.includes('onPointerEnter={event => { if (event.pointerType === "mouse") prefetchProject(project.id); }}'));
  assert(text.includes("onFocus={() => prefetchProject(project.id)}"));
  assert(text.includes("onPointerLeave={cancelProjectPrefetch}"));
  assert(text.includes("onBlur={cancelProjectPrefetch}"));
  assert.equal(text.match(/<LoadingIndicator\b/g)?.length, 1);
  assert(text.includes("<LoadingIndicator active={busy || preparingPrint}"));
});
