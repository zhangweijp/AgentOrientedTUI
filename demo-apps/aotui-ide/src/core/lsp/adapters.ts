export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}
