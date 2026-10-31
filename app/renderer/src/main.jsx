import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { shell } from './api.js';
import { setLanguage } from './i18n.js';
import './styles.css';

// The language is set before the first render, so nothing is shown in another one first.
shell.appInfo()
  .then((info) => setLanguage(info.language), () => setLanguage(null))
  .then(() => createRoot(document.getElementById('root')).render(<App />));
