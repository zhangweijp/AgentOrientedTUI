export function fileIO(folder: string): {
    read(name: string): string;
    write(name: string, text: string): void;
};
