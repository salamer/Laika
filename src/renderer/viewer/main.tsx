import '../polyfills/promiseTry';
import '../polyfills/uint8ArrayBinaryMethods';
import '../polyfills/mapGetOrInsertComputed';
import '../pdf/mathSumPrecisePolyfill';
import '../pdf/urlParsePolyfill';

import '../pdf/configurePdfWorker';

import React from 'react';
import ReactDOM from 'react-dom/client';
import ViewerApp from './ViewerApp';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<ViewerApp />);
