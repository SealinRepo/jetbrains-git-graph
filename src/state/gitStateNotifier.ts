import type { GitCache } from "../git/cache";
import type { MessageRouter } from "../messages/messageRouter";
import {
  ALL_DOMAINS,
  DOMAIN_EVENT,
  type GitDomain,
  type GitStateSink,
} from "./domains";

/**
 * 扩展主机侧唯一的 git 状态广播出口。
 *
 * 收口成一个出口是为了把「失效缓存」和「广播事件」绑死：在此之前两者散落在
 * 各个 handler 里，有的 invalidate 了才广播、有的直接广播靠 watcher 兜底。
 *
 * GitWatcher 与各命令 handler 共用这一个出口，所以实现必须幂等——同一次 git
 * 操作会被两边各通知一次（handler 那次是为了免去等 watcher 防抖的延迟）。
 */
export class GitStateNotifier implements GitStateSink {
  constructor(
    private readonly router: MessageRouter,
    private readonly caches: readonly GitCache[],
  ) {}

  notify(...domains: GitDomain[]): void {
    if (domains.length === 0) {
      return;
    }
    // 暂时一律整体失效：现在缓存的粒度跟域对不上（比如工作区改动要重拉的
    // getWorkingTreeChanges 根本不走缓存），按域细化没有实际收益。
    for (const cache of this.caches) {
      cache.invalidate();
    }
    for (const domain of new Set(domains)) {
      this.router.broadcastEvent(DOMAIN_EVENT[domain], undefined);
    }
  }

  notifyAll(): void {
    this.notify(...ALL_DOMAINS);
  }
}
