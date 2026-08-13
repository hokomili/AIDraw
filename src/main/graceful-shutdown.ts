export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface GracefulShutdownDependencies {
  stopEngine: () => Promise<void>;
  quitApplication: () => void;
  reportFailure: (error: unknown) => void;
}

/** Hold application quit until one shared engine stop has completed successfully. */
export class GracefulShutdownCoordinator {
  private complete = false;
  private stopPromise?: Promise<void>;
  private quitPromise?: Promise<void>;

  constructor(private readonly dependencies: GracefulShutdownDependencies) {}

  isComplete(): boolean {
    return this.complete;
  }

  isQuitPending(): boolean {
    return Boolean(this.quitPromise);
  }

  markComplete(): void {
    this.complete = true;
  }

  private stopEngine(): Promise<void> {
    if (this.complete) return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;
    const operation = Promise.resolve()
      .then(() => this.dependencies.stopEngine())
      .then(() => { this.complete = true; })
      .finally(() => {
        if (this.stopPromise === operation) this.stopPromise = undefined;
      });
    this.stopPromise = operation;
    return operation;
  }

  requestQuit(): Promise<void> {
    if (this.complete) {
      this.dependencies.quitApplication();
      return Promise.resolve();
    }
    if (this.quitPromise) return this.quitPromise;
    const operation = this.stopEngine()
      .then(() => { this.dependencies.quitApplication(); })
      .finally(() => {
        if (this.quitPromise === operation) this.quitPromise = undefined;
      });
    this.quitPromise = operation;
    return operation;
  }

  handleBeforeQuit(event: BeforeQuitEvent): void {
    if (this.complete) return;
    event.preventDefault();
    const alreadyPending = Boolean(this.quitPromise);
    const operation = this.requestQuit();
    if (!alreadyPending) void operation.catch((error) => { this.dependencies.reportFailure(error); });
  }
}
