export type MacosActivationPolicy = 'regular' | 'prohibited';

export interface MacosBackgroundPresentationDependencies {
  enabled: boolean;
  setActivationPolicy(policy: MacosActivationPolicy): void;
  hideDock(): void;
  showDock(): Promise<void>;
}

/**
 * Keeps a persistent macOS engine outside the foreground-application set.
 *
 * The process starts prohibited, before Electron becomes ready. Only the
 * editor lifecycle may request foreground presentation. Returning to the
 * background invalidates any in-flight Dock show and reapplies the prohibited
 * policy after that stale asynchronous operation settles.
 */
export class MacosBackgroundPresentation {
  private foregroundRequested = false;
  private promotion?: Promise<void>;

  constructor(private readonly dependencies: MacosBackgroundPresentationDependencies) {}

  prohibitBeforeReady(): void {
    if (!this.dependencies.enabled) return;
    this.foregroundRequested = false;
    this.applyBackgroundPolicy();
  }

  acceptsSystemActivation(): boolean {
    return !this.dependencies.enabled || this.foregroundRequested;
  }

  async prepareEditor(): Promise<void> {
    if (!this.dependencies.enabled) return;
    this.foregroundRequested = true;
    this.dependencies.setActivationPolicy('regular');
    if (this.promotion) return this.promotion;

    const operation = Promise.resolve()
      .then(() => this.dependencies.showDock())
      .then(() => {
        if (!this.foregroundRequested) this.applyBackgroundPolicy();
      })
      .catch((error: unknown) => {
        if (this.foregroundRequested) {
          this.foregroundRequested = false;
          this.applyBackgroundPolicy();
        }
        throw error;
      })
      .finally(() => {
        if (this.promotion === operation) this.promotion = undefined;
      });
    this.promotion = operation;
    return operation;
  }

  restoreBackground(): void {
    if (!this.dependencies.enabled) return;
    this.foregroundRequested = false;
    this.applyBackgroundPolicy();
  }

  private applyBackgroundPolicy(): void {
    this.dependencies.hideDock();
    // Electron's macOS Dock hide transforms the process to an accessory app.
    // Apply the stronger prohibited policy last so it is the observable final
    // AppKit state and the engine stays out of both Dock and app switching.
    this.dependencies.setActivationPolicy('prohibited');
  }
}
