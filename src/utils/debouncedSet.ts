/**
 * 把短时间内涌入的若干项聚合成一次回调的防抖集合。
 *
 * 语义是 trailing debounce + maxWait：
 * - 事件持续涌入时 timer 会被不断推迟，流停下来 `waitMs` 之后才触发一次，
 *   所以像全量重新构建那样的事件洪峰只会换来一次回调；
 * - 但持续不断的事件流不能把回调饿死，所以从本轮第一项算起最多憋 `maxWaitMs`
 *   就必须触发一次。
 *
 * 这里是纯机制，不认识任何业务类型——由使用方用具体类型参数化。
 */
export class DebouncedSet<T> {
  private pending = new Set<T>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 本轮第一项加入的时间戳；0 表示当前没有待处理的项 */
  private firstAddedAt = 0;

  constructor(
    private readonly onFlush: (items: Set<T>) => void,
    private readonly waitMs: number,
    private readonly maxWaitMs: number,
  ) {}

  /** 加入若干项。传空集合时什么都不做，不会启动计时。 */
  add(items: Iterable<T>): void {
    let added = false;
    for (const item of items) {
      this.pending.add(item);
      added = true;
    }
    if (!added) {
      return;
    }

    const now = Date.now();
    if (this.firstAddedAt === 0) {
      this.firstAddedAt = now;
    }

    // 正常等 waitMs，但不能越过本轮的 maxWaitMs 上限
    const remaining = this.maxWaitMs - (now - this.firstAddedAt);
    const delay = Math.max(0, Math.min(this.waitMs, remaining));

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), delay);
  }

  /** 计时到期：停表、取走攒下的项、交给回调。 */
  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.firstAddedAt = 0;

    if (this.pending.size === 0) {
      return;
    }
    // 先换掉再回调：回调里若又 add，不会影响这一批
    const items = this.pending;
    this.pending = new Set();
    this.onFlush(items);
  }

  /** 丢弃待处理项并停止计时，不触发回调。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.firstAddedAt = 0;
    this.pending.clear();
  }
}
