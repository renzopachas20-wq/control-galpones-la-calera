/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { AuthGate } from './components/AuthGate';
import { isMobileAppContainer } from './firebase/apiConfig';

if (import.meta.env.PROD && window.location.protocol.startsWith('http') &&
    !isMobileAppContainer() && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    console.warn('No se pudo activar la caché de la aplicación.');
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);


