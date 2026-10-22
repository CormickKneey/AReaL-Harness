export type ToastTone = "info" | "warning" | "error";
export type ToastMessage = { message: string; tone: ToastTone };

export function toast(message: string, tone: ToastTone = "info") {
  document.dispatchEvent(new CustomEvent<ToastMessage>("areal:toast", { detail: { message, tone } }));
}
