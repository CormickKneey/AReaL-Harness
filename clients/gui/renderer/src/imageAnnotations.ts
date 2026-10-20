import { useSyncExternalStore } from "react";
import type { Data } from "./services.js";

export type ImagePoint = { id: string; x: number; y: number; comment: string };
export type ImageAnnotationDraft = {
    id: string;
    width: number;
    height: number;
    points: ImagePoint[];
    pending: { kind: "idle" } | { kind: "new" | "edit"; point: ImagePoint };
};
export type SentImageAnnotation = {
    version: 1;
    imageNumber?: number;
    id: string;
    attachmentIndex: number;
    imageUri: string;
    name: string;
    width: number;
    height: number;
    points: { id: string; xPercent: number; yPercent: number; comment: string }[];
};
export type ImageAnnotationTarget = { draftKey: string; file: File; returnFocus: () => void };
const records = new WeakMap<File, ImageAnnotationDraft>();
const editing = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
const notify = () => { revision++; listeners.forEach(listener => listener()); };
export function useImageAnnotationPending(file?: File) {
    return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => {
        const pending = file ? records.get(file)?.pending : undefined;
        return !!pending && pending.kind !== "idle";
    });
}
export function useImageAnnotationRevision() {
    return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
}
export const imageAnnotation = (file: File) => records.get(file);
export function setImageAnnotation(file: File, record: ImageAnnotationDraft) { records.set(file, record); notify(); }
export function setImageAnnotationEditing(key: string, active: boolean) {
    if (editing.has(key) === active) return;
    if (active) editing.add(key); else editing.delete(key);
    notify();
}
export const imageAnnotationBlocked = (key: string, files: readonly File[]) => editing.has(key) || files.some(file => {
    const pending = records.get(file)?.pending;
    return pending && pending.kind !== "idle";
});
export const imagePercent = (value: number) => Math.round(value * 1000) / 10;
export const imagePointPosition = (point: { xPercent: number; yPercent: number }) => `(x: ${point.xPercent}%, y: ${point.yPercent}%)`;
const prefix = "图片标注 v1：";
export function snapshotImageAnnotations(files: readonly File[]) {
    return files.flatMap((file, attachmentIndex) => {
        const record = records.get(file);
        if (record && record.pending.kind !== "idle") throw new Error("请先确认或取消当前图片标注。");
        return record?.points.length ? [{ attachmentIndex, name: file.name, record: { ...record, points: record.points.map(point => ({ ...point })) } }] : [];
    });
}
export function imageAnnotationText(notes: readonly SentImageAnnotation[]) { return notes.map(({ imageNumber: _number, ...note }) => prefix + JSON.stringify(note)).join("\n\n"); }
export function serializeImageAnnotations(snapshot: ReturnType<typeof snapshotImageAnnotations>, attachments: Data[], offset = 0) {
    return imageAnnotationText(snapshot.map(({ attachmentIndex, name, record }) => ({
        version: 1, id: record.id, attachmentIndex: attachmentIndex + offset, imageUri: attachments[attachmentIndex].url ?? attachments[attachmentIndex].uri,
        name, width: record.width, height: record.height,
        points: record.points.map(point => ({ id: point.id, xPercent: imagePercent(point.x), yPercent: imagePercent(point.y), comment: point.comment.trim() })),
    })));
}
export function sentImageAnnotations(text: string, attachments: Data[]) {
    const notes: SentImageAnnotation[] = [];
    const indexes = new Set<number>();
    const lines = text.split("\n").filter(line => {
        if (!line.startsWith(prefix)) return true;
        try {
            const note = JSON.parse(line.slice(prefix.length));
            const part = attachments[note.attachmentIndex];
            if (note.version !== 1 || typeof note.id !== "string" || !note.id || typeof note.name !== "string" ||
                !Number.isSafeInteger(note.attachmentIndex) || note.attachmentIndex < 0 || indexes.has(note.attachmentIndex) ||
                typeof note.imageUri !== "string" || !/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(note.imageUri) ||
                !part || part.type !== "image" || (part.url ?? part.uri) !== note.imageUri ||
                ![note.width, note.height].every(value => Number.isSafeInteger(value) && value > 0) ||
                !Array.isArray(note.points) || !note.points.length ||
                !note.points.every((point: Data) => point && typeof point.id === "string" && !!point.id && typeof point.comment === "string" && !!point.comment.trim() && point.comment.length <= 4000 &&
                    [point.xPercent, point.yPercent].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)) ||
                new Set(note.points.map((point: Data) => point.id)).size !== note.points.length) return true;
            indexes.add(note.attachmentIndex); notes.push({ ...note, imageNumber: attachments.slice(0, note.attachmentIndex + 1).filter(part => part.type === "image").length }); return false;
        } catch { return true; }
    });
    return { text: lines.join("\n").trim(), notes };
}
export function imageAnnotationTitle(text: string) {
    const index = text.indexOf(prefix);
    return index < 0 ? text : text.slice(0, index).trim() || "图片标注";
}
