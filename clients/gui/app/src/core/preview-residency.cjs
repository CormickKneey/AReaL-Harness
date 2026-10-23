const MAX_CACHED_PAGES = 8;
const MAX_WORKSPACE_PAGES = 4;

function isPinned(page) {
  return !page.view || page.crashed || page.control !== 'human' || page.requestedVisible || !!page.annotationCaptureId
    || !!page.styleTrial
    || page.activeAction || page.activeRead || page.activeSelection || page.activePrepare || page.claiming || page.plans.size > 0
    || page.inputPending.size > 0 || page.heldButtons.size > 0 || page.heldKeys.size > 0
    || page.dialogPending || page.fileHandoff || (page.downloads?.size ?? 0) > 0;
}

function reserveDecision(orderedPages, { workspacePageCount, replacing, excluded }) {
  if (!replacing && workspacePageCount >= MAX_WORKSPACE_PAGES) return { kind: 'workspaceFull' };
  const native = [...orderedPages].filter(page => page.view && page !== excluded);
  if (native.length < MAX_CACHED_PAGES) return { kind: 'available' };
  const idle = native.find(page => !isPinned(page));
  return idle ? { kind: 'evict', page: idle } : { kind: 'allPinned' };
}

module.exports = { isPinned, reserveDecision };
