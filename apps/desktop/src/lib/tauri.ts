type TrayPayload = {
  activeCount: number;
  needsMeCount: number;
  blockedCount: number;
  readyCount: number;
};

function hasTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function pickRepoDirectory() {
  if (!hasTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
  });
  return typeof selected === "string" ? selected : null;
}

export async function syncTray(payload: TrayPayload) {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_tray_counts", { counts: payload });
}

export async function notifyUrgent(title: string, body: string) {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("notify_urgent", { title, body });
}

export async function copyTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("copy_to_clipboard", { value });
  }
}

export async function openCommandInTerminal(command: string, cwd?: string | null) {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_in_terminal", { command, cwd: cwd ?? null });
}
