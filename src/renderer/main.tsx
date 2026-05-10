import './polyfills/promiseTry';
import './polyfills/uint8ArrayBinaryMethods';
import './polyfills/mapGetOrInsertComputed';
import './pdf/mathSumPrecisePolyfill';
import './pdf/urlParsePolyfill';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
