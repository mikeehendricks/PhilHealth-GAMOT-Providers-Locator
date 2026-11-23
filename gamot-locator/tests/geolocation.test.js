const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../public/js/app.js'), 'utf8');
const locateSource = source.slice(source.indexOf('function locate(onSuccess)'), source.indexOf('\nfunction startWatch()'));

function setup(options = {}) {
  const calls = [];
  const context = {
    window: { isSecureContext: options.secure !== false },
    navigator: { geolocation: options.geolocation },
    state: { map: { setView: (...args) => calls.push(['view', ...args]) } },
    toast: (...args) => calls.push(['toast', ...args]),
    setLocating: (value) => calls.push(['loading', value]),
    placeUserMarker: () => calls.push(['marker']),
    showNearest: () => calls.push(['nearest']),
    startWatch: () => calls.push(['watch']),
  };
  context.window.self = {};
  context.window.top = options.embedded ? {} : context.window.self;
  vm.createContext(context);
  vm.runInContext(locateSource, context);
  return { context, calls };
}

{
  const { context, calls } = setup({ secure: false });
  context.locate();
  assert.match(calls[0][1], /HTTPS/);
}
{
  let request;
  const { context, calls } = setup({ geolocation: { getCurrentPosition: (...args) => { request = args; } } });
  context.locate(() => calls.push(['callback']));
  assert.strictEqual(request[2].enableHighAccuracy, false);
  request[0]({ coords: { latitude: 14, longitude: 121, accuracy: 50 } });
  assert.strictEqual(context.state.userPos.lat, 14);
  assert.deepStrictEqual(calls.map(c => c[0]), ['loading', 'loading', 'marker', 'nearest', 'view', 'watch', 'callback']);
}
for (const [code, expected] of [[1, /device’s Location Services/], [2, /unavailable/], [3, /timed out/]]) {
  const { context, calls } = setup({ geolocation: { getCurrentPosition: (ok, fail) => fail({ code }) } });
  context.locate();
  assert.strictEqual(calls[1][1], false);
  assert.match(calls[2][1], expected);
}
{
  const { context, calls } = setup({ embedded: true, geolocation: { getCurrentPosition: (ok, fail) => fail({ code: 1 }) } });
  context.locate();
  assert.match(calls[2][1], /directly/);
}
console.log('Geolocation tests passed');
