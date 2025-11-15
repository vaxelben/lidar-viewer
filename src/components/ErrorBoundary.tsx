import React, { Component, ReactNode } from 'react';
import { Html } from '@react-three/drei';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Erreur capturée:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <Html center>
          <div style={{
            background: 'rgba(200, 0, 0, 0.9)',
            color: 'white',
            padding: '20px 40px',
            borderRadius: '8px',
            fontSize: '14px',
            fontFamily: 'monospace',
            maxWidth: '500px',
            textAlign: 'left'
          }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px' }}>
              ❌ Erreur de chargement
            </h3>
            <p style={{ margin: '5px 0' }}>
              {this.state.error?.message || 'Une erreur est survenue'}
            </p>
            <details style={{ marginTop: '15px', fontSize: '12px', opacity: 0.8 }}>
              <summary style={{ cursor: 'pointer', marginBottom: '5px' }}>
                Détails techniques
              </summary>
              <pre style={{ 
                background: 'rgba(0, 0, 0, 0.3)', 
                padding: '10px', 
                borderRadius: '4px',
                overflow: 'auto',
                maxHeight: '200px'
              }}>
                {this.state.error?.stack || 'Aucun détail disponible'}
              </pre>
            </details>
          </div>
        </Html>
      );
    }

    return this.props.children;
  }
}

