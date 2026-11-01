import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Intro from './screens/Intro.jsx';
import { shell } from './api.js';
import { setLanguage } from './i18n.js';
import './styles.css';

// The explanation of what the app reads comes first when the main process asks for it; the app reads nothing outside
// its own folders before.
function Root() {
  const [intro, setIntro] = useState(null);
  useEffect(() => {
    shell.intro().then(setIntro, () => setIntro({ ready: true }));
  }, []);
  if (!intro) return null;
  return intro.ready ? <App /> : <Intro platform={intro.platform} onDone={() => setIntro({ ...intro, ready: true })} />;
}

// The language is set before the first render, so nothing is shown in another one first.
shell.appInfo()
  .then((info) => setLanguage(info.language), () => setLanguage(null))
  .then(() => createRoot(document.getElementById('root')).render(<Root />));
