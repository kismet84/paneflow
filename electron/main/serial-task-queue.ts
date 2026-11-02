export class SerialTaskQueue {
  #tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.catch(() => undefined).then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
