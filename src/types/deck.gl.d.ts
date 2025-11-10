declare module '@deck.gl/core' {
  export const COORDINATE_SYSTEM: any;
  export class OrbitView {
    constructor(options?: any);
  }
}

declare module '@deck.gl/react' {
  import * as React from 'react';
  
  export interface DeckGLProps {
    layers: any[];
    views?: any;
    viewState?: any;
    onViewStateChange?: (params: { viewState: any }) => void;
    controller?: boolean;
    [key: string]: any;
  }
  
  export default class DeckGL extends React.Component<DeckGLProps> {}
}

declare module '@deck.gl/layers' {
  export class PointCloudLayer {
    constructor(props: any);
  }
}

declare module '@loaders.gl/core' {
  export function load(url: string, loader: any, options?: any): Promise<any>;
}

declare module '@loaders.gl/las' {
  export const LASLoader: any;
} 