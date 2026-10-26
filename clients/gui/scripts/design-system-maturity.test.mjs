import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeTempDir } from "./support/temp.mjs";
import { collectUiAdoption } from "./design-system-maturity.mjs";

test("UI adoption follows actual quoted, aliased and multiline pure reexports only", async () => {
  const root = await makeTempDir("areal-ui-adoption-");
  const put = async (file, source) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  };
  try {
    for (const name of ["Button", "Dialog"])
      await put(
        `packages/ui/src/${name}.md`,
        `---\nid: ${name}\nlayer: core\nstatus: stable\nexports: ["${name}"]\n---\n`,
      );
    await put("renderer/src/components/ui/button.tsx", 'export { Button } from "@areal/ui";');
    await put(
      "renderer/src/components/ui/dialog.tsx",
      'export {\n Dialog,\n DialogTitle,\n DialogContent,\n} from "@areal/ui/experimental";',
    );
    await put(
      "renderer/src/components/ui/business.tsx",
      'export { Dialog } from "@areal/ui/experimental";\nexport function Localized() { return null; }',
    );
    await put(
      "renderer/src/Direct.tsx",
      'import { Button } from "@areal/ui";\nexport const view = <Button/>;',
    );
    await put(
      "renderer/src/Quoted.tsx",
      "import { Button } from './components/ui/button.js';\nexport const view = <Button/>;",
    );
    await put(
      "renderer/src/Alias.tsx",
      'import { Button } from "@/components/ui/button.js";\nexport const view = <Button/>;',
    );
    await put(
      "renderer/src/Multiline.tsx",
      'import { Dialog } from "./components/ui/dialog.js";\nexport const view = <Dialog/>;',
    );
    await put(
      "renderer/src/Business.tsx",
      'import { Dialog } from "./components/ui/business.js";\nexport const view = <Dialog/>;',
    );
    await put(
      "renderer/src/Unknown.tsx",
      'import { Unknown } from "@areal/ui";\nexport const view = <Unknown/>;',
    );
    assert.deepEqual(await collectUiAdoption({ root }), { files: 9, consumers: 4 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
