/** Mounted View identities activate the App's shared ViewType Tools. */
export interface IViewOwnedToolPort {
    mount(viewId: string, viewType: string): string;
    unmount(viewInstanceId: string): void;
}
