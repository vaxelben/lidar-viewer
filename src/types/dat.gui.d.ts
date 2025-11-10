declare module 'dat.gui' {
  export interface Controller {
    listen(): Controller;
    name(name: string): Controller;
  }

  export class GUI {
    constructor(options?: { autoPlace?: boolean; closed?: boolean; closeOnTop?: boolean; load?: any; name?: string; preset?: string; width?: number });
    add(object: any, property: string, min?: number, max?: number, step?: number): Controller;
    add(object: any, property: string, items: string[]): Controller;
    add(object: any, property: string, status: boolean): Controller;
    addColor(object: any, property: string): Controller;
    addFolder(name: string): GUI;
    remove(controller: any): void;
    destroy(): void;
    open(): void;
    close(): void;
    show(): void;
    hide(): void;
    listen(controller: any): void;
    updateDisplay(): void;
    domElement: HTMLElement;
  }
}

