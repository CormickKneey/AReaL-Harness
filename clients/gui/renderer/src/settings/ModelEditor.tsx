import { useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsDialog } from "./common.js";
import type { Data } from "../services.js";
import "./ModelEditor.css";

const reasoningEfforts = [
  ["none", "无"], ["minimal", "最少"], ["low", "低"], ["medium", "中"],
  ["high", "高"], ["xhigh", "极高"], ["max", "最高"],
] as const;

export function ModelEditor({ model, editing, ids, onSave, onClose }: {
  model: Data; editing: boolean; ids: string[]; onSave: (model: Data) => void; onClose: () => void;
}) {
  const [id, setId] = useState(model.id ?? "");
  const [name, setName] = useState(model.displayName ?? "");
  const [context, setContext] = useState(String(model.parameters?.contextWindowTokens ?? ""));
  const [maximum, setMaximum] = useState(String(model.parameters?.maxOutputTokens ?? ""));
  const initialTools = model.capabilities?.tools ?? true;
  const initialVision = model.capabilities?.vision ?? editing;
  const initialReasoning = model.capabilities?.reasoning ?? editing;
  const initialEfforts: string[] = model.capabilities?.reasoningEffortOptions ?? [];
  const [tools, setTools] = useState(initialTools);
  const [vision, setVision] = useState(initialVision);
  const [reasoning, setReasoning] = useState(initialReasoning);
  const [efforts, setEfforts] = useState<string[]>(initialEfforts);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const idInput = useRef<HTMLInputElement>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const maximumInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const capabilitiesChanged = tools !== initialTools || vision !== initialVision || reasoning !== initialReasoning
    || JSON.stringify(efforts) !== JSON.stringify(initialEfforts);
  const dirty = id !== (model.id ?? "") || name !== (model.displayName ?? "")
    || context !== String(model.parameters?.contextWindowTokens ?? "")
    || maximum !== String(model.parameters?.maxOutputTokens ?? "")
    || capabilitiesChanged;
  const requestClose = () => dirty ? setConfirmDiscard(true) : onClose();
  const invalid = (field: string) => ({
    "aria-invalid": invalidField === field || undefined,
    "aria-describedby": invalidField === field ? errorId : undefined,
  });
  const fail = (field: string, message: string, input: HTMLInputElement | null) => {
    setInvalidField(field);
    setError(message);
    input?.focus();
  };
  return <SettingsDialog title={editing ? "编辑模型" : "添加模型"} description="设置模型名称、容量和支持的能力。" className="model-editor-dialog" onClose={requestClose}>
    <form className="model-editor" noValidate onSubmit={e => {
      e.preventDefault();
      if (!id.trim() || ids.includes(id.trim())) { fail("id", "模型 ID 不能为空或重复", idInput.current); return; }
      if (contextInput.current?.validity.badInput || (context && (!Number.isSafeInteger(Number(context)) || Number(context) <= 0 || Number(context) > 2_000_000))) {
        fail("context", "上下文长度须为 1 到 2000000 之间的整数", contextInput.current); return;
      }
      if (maximumInput.current?.validity.badInput || (maximum && (!Number.isSafeInteger(Number(maximum)) || Number(maximum) <= 0))) {
        fail("maximum", "最大输出必须是正整数", maximumInput.current); return;
      }
      const parameters = { ...model.parameters };
      delete parameters.contextWindowTokens;
      delete parameters.maxOutputTokens;
      if (!editing || capabilitiesChanged) {
        if (!reasoning) {
          delete parameters.reasoningEffort;
          delete parameters.reasoningSummary;
        } else if (efforts.length > 0 && parameters.reasoningEffort && !efforts.includes(parameters.reasoningEffort)) {
          delete parameters.reasoningEffort;
        }
      }
      onSave({ ...model, id: id.trim(), displayName: name.trim(),
        ...(!editing || capabilitiesChanged ? { capabilities: {
          tools, vision, reasoning,
          ...(reasoning && efforts.length ? { reasoningEffortOptions: efforts } : {}),
        } } : {}),
        parameters: {
          ...parameters,
          ...(context ? { contextWindowTokens: Number(context) } : {}),
          ...(maximum ? { maxOutputTokens: Number(maximum) } : {}),
        },
      });
    }}>
      <div className="model-editor-grid">
        <label>模型 ID<Input ref={idInput} {...invalid("id")} aria-label="模型 ID" required maxLength={256} placeholder="服务提供的模型 ID" value={id} onChange={e => setId(e.target.value)} /></label>
        <label>显示名称<Input aria-label="显示名称" maxLength={128} placeholder="留空使用模型 ID" value={name} onChange={e => setName(e.target.value)} /></label>
      </div>
      <section className="model-editor-parameters" aria-label="模型生成参数">
        <div className="model-editor-grid">
          <label>上下文长度 Token<Input ref={contextInput} {...invalid("context")} aria-label="模型上下文 Token" type="number" min={1} max={2_000_000} step={1} placeholder="供应商默认" value={context} onChange={e => setContext(e.target.value)} /></label>
          <label>最大输出 Token<Input ref={maximumInput} {...invalid("maximum")} aria-label="模型最大输出 Token" type="number" min={1} step={1} placeholder="供应商默认" value={maximum} onChange={e => setMaximum(e.target.value)} /></label>
        </div>
        <p className="model-editor-inherit-note">留空沿用供应商默认值。</p>
      </section>
      <section className="model-editor-capabilities" aria-label="模型能力">
        <div className="model-capability-row"><span>工具调用</span><Switch aria-label="工具调用" checked={tools} onCheckedChange={setTools} /></div>
        <div className="model-capability-row"><span>视觉输入</span><Switch aria-label="视觉输入" checked={vision} onCheckedChange={setVision} /></div>
        <div className="model-capability-row"><span>推理能力</span><Switch aria-label="推理能力" checked={reasoning} onCheckedChange={setReasoning} /></div>
        {reasoning && <div className="model-editor-efforts" role="group" aria-label="允许的推理强度">
          <span>允许的推理强度</span>
          <div className="model-effort-options">{reasoningEfforts.map(([value, label]) => <label className="model-effort-option" key={value}>
            <Input type="checkbox" checked={efforts.includes(value)} onChange={event => {
              const checked = event.target.checked;
              setEfforts(previous => reasoningEfforts.map(([option]) => option).filter(option => option === value ? checked : previous.includes(option)));
            }} />
            <span>{label}</span>
          </label>)}</div>
          <p>未选择时沿用现有可选强度。</p>
        </div>}
      </section>
      <Feedback id={errorId} error={error} />
      <p className="settings-muted model-editor-save-note">保存到供应商草稿，保存供应商后生效。</p>
      <footer><Button type="button" variant="outline" onClick={requestClose}>取消</Button><Button type="submit">保存模型</Button></footer>
    </form>
    {confirmDiscard && <SettingsDialog title="放弃模型修改？" description="尚未保存的模型设置将丢失。" onClose={() => setConfirmDiscard(false)}>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setConfirmDiscard(false)}>继续编辑</Button>
        <Button variant="destructive" onClick={onClose}>放弃修改</Button>
      </div>
    </SettingsDialog>}
  </SettingsDialog>;
}
