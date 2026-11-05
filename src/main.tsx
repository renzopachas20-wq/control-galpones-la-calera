import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { testFirebaseConnection } from './firebase/config';
import { AuthGate } from './components/AuthGate';

void testFirebaseConnection();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);


