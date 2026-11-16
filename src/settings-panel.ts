// The display settings dialog. Changes apply at once, so flight keeps going
// behind it and the effect is visible while choosing.
import type { DisplaySettings, QualityMode } from "./quality.ts";

const DEFAULT_NOTE = "Auto lowers it if flight runs slowly.";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export class SettingsPanel {
  private dialog = byId<HTMLDialogElement>("settings");
  private glow = byId<HTMLInputElement>("setting-glow");
  private twinkle = byId<HTMLInputElement>("setting-twinkle");
  private quality = byId<HTMLSelectElement>("setting-quality");
  private note = byId<HTMLElement>("quality-note");
  private settings: DisplaySettings;
  private onChange: (settings: DisplaySettings) => void;

  constructor({
    settings,
    onChange,
    onClose,
  }: {
    settings: DisplaySettings;
    onChange: (settings: DisplaySettings) => void;
    onClose: () => void;
  }) {
    this.settings = { ...settings };
    this.onChange = onChange;
    this.render();
    byId("settings-button").addEventListener("click", () => this.open());
    byId("close-settings").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", onClose);
    const update = () => {
      this.settings = {
        glow: this.glow.checked,
        twinkle: this.twinkle.checked,
        quality: this.quality.value as QualityMode,
      };
      this.onChange({ ...this.settings });
    };
    for (const input of [this.glow, this.twinkle, this.quality])
      input.addEventListener("change", update);
  }
  get isOpen(): boolean {
    return this.dialog.open;
  }
  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
  }
  /** Explains what automatic quality is doing, when it has stepped in. */
  setNote(text: string | null): void {
    this.note.textContent = text ?? DEFAULT_NOTE;
  }
  private render(): void {
    this.glow.checked = this.settings.glow;
    this.twinkle.checked = this.settings.twinkle;
    this.quality.value = this.settings.quality;
  }
}
