// src/services/stageCache/scheduler.ts — 消费者取消不释放底层生成槽，最多一个运行和一个等待目标。
export const STAGE_PRIORITY = { manual: 3, current: 2, next: 1 } as const;
export type StagePriority = keyof typeof STAGE_PRIORITY;
export interface StageScheduleRequest<T> {
    /** 必须包含云命名空间及个性化域，避免不同来源共享。 */
    key: string;
    priority: StagePriority;
    generate: () => Promise<T>;
    signal?: AbortSignal;
    isValid?: () => boolean;
    /** 出队时重查缓存；返回 undefined 才真正生成。 */
    beforeRun?: () => Promise<T | undefined>;
}
interface Consumer<T> {
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    valid: () => boolean;
    detach: () => void;
}
interface Job<T> {
    request: StageScheduleRequest<T>;
    consumers: Set<Consumer<T>>;
    priority: number;
    started: boolean;
}
const abortError = () => new DOMException('Stage request superseded or cancelled', 'AbortError');

export const createStageScheduler = <T>(options: { failureBackoffMs?: number; maxBackoffMs?: number } = {}) => {
    let running: Job<T> | undefined;
    let waiting: Job<T> | undefined;
    let failures = 0;
    let retryAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finishConsumer = (job: Job<T>, consumer: Consumer<T>, error?: unknown, value?: T) => {
        consumer.detach();
        job.consumers.delete(consumer);
        if (error) consumer.reject(error);
        else consumer.resolve(value as T);
    };
    const cancelJob = (job: Job<T>) => {
        for (const consumer of [...job.consumers]) finishConsumer(job, consumer, abortError());
    };
    const prune = (job: Job<T>) => {
        for (const consumer of [...job.consumers]) {
            let valid = false;
            try { valid = consumer.valid(); } catch { /* 失效检查异常同样禁止生成。 */ }
            if (!valid) finishConsumer(job, consumer, abortError());
        }
        return job.consumers.size > 0;
    };
    // 等待底层 Promise 真正 settle 才释放槽；不把取消信号传给共享生成。
    const execute = async (job: Job<T>) => {
        try {
            if (!prune(job)) return;
            const cached = await job.request.beforeRun?.();
            if (!prune(job)) return;
            const value = cached === undefined ? await job.request.generate() : cached;
            failures = 0;
            retryAt = 0;
            for (const consumer of [...job.consumers]) {
                finishConsumer(job, consumer, consumer.valid() ? undefined : abortError(), value);
            }
        } catch (error) {
            failures = Math.min(failures + 1, 8);
            retryAt = Date.now() + Math.min(options.maxBackoffMs ?? 30_000,
                (options.failureBackoffMs ?? 1_000) * 2 ** (failures - 1));
            for (const consumer of [...job.consumers]) finishConsumer(job, consumer, error);
        } finally {
            if (running === job) running = undefined;
            pump();
        }
    };
    const pump = () => {
        if (running || !waiting) return;
        if (!prune(waiting)) { waiting = undefined; return; }
        const delay = waiting.priority < STAGE_PRIORITY.manual ? retryAt - Date.now() : 0;
        if (delay > 0) {
            if (!timer) timer = setTimeout(() => { timer = undefined; pump(); }, delay);
            return;
        }
        const job = waiting;
        waiting = undefined;
        running = job;
        job.started = true;
        void execute(job);
    };
    const request = (input: StageScheduleRequest<T>): Promise<T> => {
        if (input.signal?.aborted) return Promise.reject(abortError());
        // 没有消费者的旧任务不能在 A→B→A 时被重新订阅。
        let job = [running, waiting].find(candidate => candidate?.request.key === input.key && candidate.consumers.size);
        if (!job) {
            if (waiting && !prune(waiting)) waiting = undefined;
            if (waiting && waiting.priority > STAGE_PRIORITY[input.priority]) return Promise.reject(abortError());
            if (waiting) cancelJob(waiting);
            job = { request: input, consumers: new Set(), priority: STAGE_PRIORITY[input.priority], started: false };
            waiting = job;
        }
        job.priority = Math.max(job.priority, STAGE_PRIORITY[input.priority]);
        const target = job;
        const promise = new Promise<T>((resolve, reject) => {
            const cancel = () => {
                finishConsumer(target, consumer, abortError());
                if (!target.started && target.consumers.size === 0 && waiting === target) waiting = undefined;
            };
            const consumer: Consumer<T> = { resolve, reject,
                valid: () => !input.signal?.aborted && (input.isValid?.() ?? true),
                detach: () => input.signal?.removeEventListener('abort', cancel) };
            target.consumers.add(consumer);
            input.signal?.addEventListener('abort', cancel, { once: true });
        });
        pump();
        return promise;
    };
    return { request,
        getState: () => ({ runningKey: running?.request.key, waitingKey: waiting?.request.key, failures, retryAt }),
        dispose: () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
            if (waiting) cancelJob(waiting);
            waiting = undefined;
            if (running) cancelJob(running);
        },
    };
};
