export function fileIO(folder: string): {
    list(): string[];
    read(name: string): string | undefined;
    write(name: string, text: string): boolean;
};
