import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIsolated } from './build-isolated.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { createFirebaseIdentityProvider, createFirestoreProfileStore, createNamedFirestore, registerAuthRoutes } from '../server/firebaseAdmin.ts';
import { createAuthService } from '../server/auth.ts';
import { registerOperationalRoutes } from '../server/operations.ts';
import { apiCors } from '../server/cors.ts';
const project = 'demo-calera-phase11';
const runId = randomUUID().slice(0, 8);
const uidFor = name => 'browser-' + runId + '-' + name;
const host=process.env.FIREBASE_AUTH_EMULATOR_HOST;
assert.match(host,/^127\.0\.0\.1:\d+$/);
assert.match(process.env.FIRESTORE_EMULATOR_HOST,/^127\.0\.0\.1:\d+$/);
let chromium, api, ws, db;
const chrome = process.env.CALERA_CHROME || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'chromium');
if (process.platform === 'win32' && !existsSync(chrome)) throw new Error('Indique CALERA_CHROME con la ruta de Chrome o Edge.');
const password='Synthetic-Browser#947';
const origin='http://127.0.0.1';
const testPage=(name)=>'http://127.0.0.1:'+api.address().port+'/#/'+name;
async function until(fn, description, attempts=120) {
 for(let n=0;n<attempts;n++){
  try{const value=await fn();if(value)return value;}catch{}
  await sleep(200);
 }
 throw Error('No se confirmó: '+description);
}
await buildIsolated(async (dist, copy) => {
try {
 db = createNamedFirestore(project, 'calera-browser-' + runId);
 const identity=createFirebaseIdentityProvider(project);
 const service=createAuthService(identity,createFirestoreProfileStore(db));
 const app=express();
 app.use('/api', apiCors(undefined, false, false));
 app.use(express.json());
 registerAuthRoutes(app,service);
 registerOperationalRoutes(app,db,service);
 app.get('/api/health',(_q,res)=>res.json({ok:true}));
 app.get('/api/version',(_q,res)=>res.json({version:'synthetic'}));
 app.use(express.static(dist));
 api=app.listen(0,'127.0.0.1');
 await once(api,'listening');
 const barn={id:'barn-smoke',sectorId:'sector-smoke',code:'SMK-01',name:'Galpón sintético',areas:[{id:'area',name:'Obra Civil',hasSistemas:false,structures:[{id:'s1',name:'Pórtico',activities:[{id:'a1',code:'SMOKE-ACT',name:'Actividad sintética',targetUnits:10,unit:'u',weight:1,startDate:'2026-01-01',dueDate:'2026-12-30',status:'Pendiente'}]}]}]};
 await db.doc('sectors/sector-smoke').create({id:'sector-smoke',code:'P-SYN',name:'Sector sintético',galpones:[{...barn, areas:[{...barn.areas[0], structures:[
   barn.areas[0].structures[0],
   {id:'s2',name:'Segundo Pórtico',activities:[{id:'a-pct',code:'SMOKE-ACT',name:'Actividad en porcentaje',progressMode:'percentage',targetUnits:100,unit:'%',weight:1,startDate:'2026-01-01',dueDate:'2026-12-30'}]}
 ]}]},{...barn,id:'barn-secondary',code:'SMK-02',name:'Galpón secundario'}]});
 await db.doc('sectors/z-sector-other').create({name:'Otro sector',code:'P-OTHER',
   galpones:[{...barn,id:'barn-other',code:'SMK-03',name:'Otro galpón',sectorId:'z-sector-other'}]});
 await db.doc('providers/prov_SYNTECH').create({name:'SYNTECH'});
 for (const [id, galponId] of [['stock-main','barn-smoke'],['stock-secondary','barn-secondary']]) {
   await db.doc('materials/' + id).create({ code: 'SHARED-STOCK', name: 'Perno compartido', unit: 'u',
     sectorId: 'sector-smoke', galponId, areaId: 'area', areaName: 'Obra Civil', structureId: 's1',
     structureName: 'Pórtico', technology: 'SYNTECH', totalQty: 20, initialUsedQty: 1, usedQty: 1 });
 }
 await db.doc('workers/worker-smoke').create({id:'worker-smoke',workerCode:'W-SYN',name:'Operario sintético',role:'Montaje',active:true,sectorId:'sector-smoke',galponId:'barn-smoke'});
 for(const [name,role] of [['admin','Administrador'],['helper','Auxiliar'],['reader','Solo lectura'],['manager','Jefe de proyecto'],['supervisor','Supervisor'],['warehouse','Almacén']]){
  const uid=uidFor(name), email=uid+'@example.test';
  await identity.createUser({uid,email,password});
  await db.doc('users/'+uid).create({uid,email,role,active:true,authMethod:'password',displayName:'Sintético '+name,createdAt:new Date().toISOString()});
 }
 const profilePath=join(copy,'chrome-profile');
 chromium=spawn(chrome,[
  '--headless=new','--remote-debugging-port=0','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check',
  '--disable-component-update','--disable-default-apps','--disable-features=OptimizationHints,MediaRouter,Translate','--user-data-dir='+profilePath,
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1','about:blank'
 ],{stdio:'ignore',windowsHide:true});
 const debug=await until(()=>readFileSync(join(profilePath,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0],'arranque de Chromium');
 const targets=await (await fetch(origin+':'+debug+'/json/list')).json();
 ws=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
 await once(ws,'open');
 let id=0;
 let operationalReads = 0;
 const pageExceptions = [];
 const pending=new Map();
 ws.addEventListener('message', event=>{
  const msg=JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') pageExceptions.push(msg.params.exceptionDetails.text);
  if (msg.method === 'Network.requestWillBeSent' && /\/api\/data\//.test(msg.params.request.url)) operationalReads++;
  const entry=pending.get(msg.id);
  if(entry){pending.delete(msg.id);clearTimeout(entry.timer);if(msg.error)entry.reject(new Error(msg.error.message));else entry.resolve(msg.result);}
 });
 const cmd=(method,params={})=>new Promise((resolve,reject)=>{
  const seq=++id;
  const timer=setTimeout(()=>{pending.delete(seq);reject(Error('CDP timeout '+method));},10000);
  pending.set(seq,{resolve,reject,timer});
  ws.send(JSON.stringify({id:seq,method,params}));
 });
 const evaluate=async expression=>{
  const data=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(data.exceptionDetails)throw Error(data.exceptionDetails.text);
  return data.result.value;
 };
 const text=()=>evaluate('document.body?.innerText || ""');
 const click=testId=>evaluate('(document.querySelector('+JSON.stringify('[data-testid="'+testId+'"]')+')?.click(), true)');
 const exists=testId=>evaluate('!!document.querySelector('+JSON.stringify('[data-testid="'+testId+'"]')+')');
 const clickText = label => evaluate(`(() => {
   const button = [...document.querySelectorAll('button')].find(item => !item.disabled && item.textContent.trim() === ${JSON.stringify(label)});
   button?.click();
   return !!button;
 })()`);
 const setValue = (selector, value, kind = 'HTMLInputElement', event = 'input') => evaluate(`(() => {
   const field = document.querySelector(${JSON.stringify(selector)});
   if (!field) return false;
   Object.getOwnPropertyDescriptor(${kind}.prototype, 'value').set.call(field, ${JSON.stringify(value)});
   field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
   return true;
 })()`);
 async function selectFile(selector, fixture) {
   const { root } = await cmd('DOM.getDocument');
   const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector });
   assert.ok(nodeId, 'Selector de archivo ' + selector);
   await cmd('DOM.setFileInputFiles', { nodeId, files: [fixture] });
 }
 await cmd('Network.enable');
 await cmd('Runtime.enable');
 await cmd('Page.enable');
 await cmd('Page.navigate',{url:testPage('dashboard')});
 async function loginWith(email, secret){
  await until(()=>exists('login-screen'),'formulario de acceso');
  await evaluate('(() => {const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; for(const [id,value] of '+JSON.stringify([['login-email',email],['login-password',secret]])+'){const field=document.getElementById(id);setter.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));}document.querySelector("form button[type=submit]").click()})()');
 }
 const login = name => loginWith(uidFor(name)+'@example.test', password);
 async function logout(){
  await evaluate('(() => { const button=[...document.querySelectorAll("button")].find(b=>b.title==="Cerrar sesión"||b.textContent.trim()==="Cerrar sesión"); if(button)button.click(); return !!button; })()');
  await until(()=>exists('login-screen'),'cierre de sesión');
 }
 await login('admin');
 await cmd('Page.setDownloadBehavior',{behavior:'allow',downloadPath:copy});
 await until(async()=> (await text()).includes('Avance de proyectos y galpones'),'Dashboard de Administrador');
 await until(() => clickText('Usuarios'), 'abrir Administración de usuarios');
 await until(() => clickText('Nuevo Usuario'), 'abrir alta en Administración');
 const accountEmail = 'browser-created-' + runId + '@example.test';
 assert.ok(await setValue('input[placeholder="Ej. Juan Pérez Quispe"]', 'Supervisión de aceptación'));
 assert.ok(await setValue('input[placeholder="usuario@lacalera.pe"]', accountEmail));
 assert.ok(await setValue('select:has(option[value="Supervisor"])', 'Supervisor', 'HTMLSelectElement', 'change'));
 const accountPassword = await evaluate(`document.querySelector('form input[minlength="20"]')?.value`);
 assert.ok(typeof accountPassword === 'string' && accountPassword.length >= 20);
 assert.ok(await clickText('Crear Usuario Autorizado'));
 await until(async () => (await text()).includes('creado con rol Supervisor'), 'alta confirmada en interfaz');
 const account = await identity.getUserByEmail(accountEmail);
 assert.equal((await db.doc('users/' + account.uid).get()).get('role'), 'Supervisor');
 assert.ok(await evaluate(`(() => {
   const heading = [...document.querySelectorAll('h2')].find(node => node.textContent.includes('Administración de Usuarios'));
   const close = heading?.closest('.bg-slate-900')?.querySelector('button'); close?.click(); return !!close;
 })()`));
 await logout();
 await loginWith(accountEmail, accountPassword);
 await until(() => exists('bottom-nav-gantt'), 'Supervisor creado inicia sesión sin asignaciones');
 await logout();
 await login('admin');
 console.log('Chromium: alta de Supervisor desde Administración y primer acceso con la cuenta creada.');
 await until(async()=> (await text()).includes('4 actividades'),'actividad sintética del Dashboard');
 assert.ok(await setValue('section[aria-labelledby=portfolio-title] select:has(option[value=P-SYN])', 'P-SYN', 'HTMLSelectElement', 'change'));
 assert.ok(await setValue('section[aria-labelledby=portfolio-title] select:has(option[value=sector-smoke])', 'sector-smoke', 'HTMLSelectElement', 'change'));
 await until(async () => (await text()).includes('3 actividades'), 'Dashboard filtrado por proyecto y sector');
 assert.ok(await clickText('Exportar avance CSV'));
 const portfolioCsv = await until(() => readdirSync(copy).find(name => /^Avance_proyectos_.*\.csv$/.test(name)), 'CSV de Dashboard');
 const portfolioRows = readFileSync(join(copy, portfolioCsv), 'utf8');
 assert.match(portfolioRows, /"Proyecto","Sector","Galpón"/);
 assert.ok(!portfolioRows.includes('P-OTHER'));
 assert.ok(await setValue('[data-testid=selector-sector]', 'sector-smoke', 'HTMLSelectElement', 'change'));
 await until(() => setValue('[data-testid=selector-galpon]', 'barn-smoke', 'HTMLSelectElement', 'change'), 'galpón de prueba seleccionado');
 for(const [width,height,mobile] of [[1366,768,false],[820,1180,true],[390,844,true]]){
  await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
  assert.ok(await exists('bottom-nav-dashboard'));
  assert.ok(await exists('bottom-nav-gantt'));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'),true,'desborde horizontal del Dashboard');
  const navFits=await evaluate('(() => {const r=document.querySelector("[data-testid=bottom-navigation-bar]").getBoundingClientRect();return r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;})()');
  assert.ok(navFits,'navegación dentro del viewport');
  await click('bottom-nav-gantt');
  await until(()=>exists('gantt-btn-export'),'Gantt en viewport '+width);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'),true,'desborde horizontal del Gantt');
  await click('bottom-nav-dashboard');
  await until(async()=> (await text()).includes('Avance de proyectos y galpones'),'volver a Dashboard');
  console.log('Chromium viewport '+width+'x'+height+': Dashboard, Gantt y navegación dentro de pantalla.');
 }

 await click('bottom-nav-gantt');
 await until(()=>evaluate('document.querySelector("[data-testid=gantt-btn-export]")?.disabled===false'),'exportación Gantt habilitada');
 await click('gantt-btn-export');
 const workbookPath=await until(()=>{const name=readdirSync(copy).find(file=>file.endsWith('.xlsx'));return name&&join(copy,name);},'archivo de exportación Gantt');
 const XLSX=await import('xlsx');
 const book=XLSX.read(readFileSync(workbookPath));
 assert.ok(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1}).flat().includes('SMOKE-ACT'));
 const ganttDue = 'tr:has(td[title="Actividad en porcentaje"]) input[aria-label^="Fecha fin"]';
 assert.ok(await setValue(ganttDue, '2026-12-23'));
 await until(async () => {
   const sector = (await db.doc('sectors/sector-smoke').get()).data();
   return sector.galpones[0].areas[0].structures[1].activities[0].dueDate === '2026-12-23' &&
     sector.galpones[0].areas[0].structures[0].activities[0].dueDate === '2026-12-30';
 }, 'edición de Gantt sobre una sola actividad');
 await click('sidebar-link-movimientos');
 await until(async()=> (await text()).includes('Historial de Movimientos de Usuarios'),'pantalla de movimientos');
 const fixturePath=join(copy,'historico.csv');
 writeFileSync(fixturePath,'ID,timestamp,module,type,detail\nsmoke-history,2026-11-08T13:00:00Z,Control de Materiales,REGISTRO,Importación sintética desde Chromium\n','utf8');
 const {root}=await cmd('DOM.getDocument');
 const {nodeId}=await cmd('DOM.querySelector',{nodeId:root.nodeId,selector:'input[accept=".csv,.xlsx"]'});
 assert.ok(nodeId);
 await cmd('DOM.setFileInputFiles',{nodeId,files:[fixturePath]});
 try {
   await until(async () => (await db.collection('movements').where('sourceId', '==', 'smoke-history').get()).docs.some(doc =>
     doc.get('detail') === 'Importación sintética desde Chromium'), 'importación histórica UTF-8 desde interfaz');
 } catch (error) {
   console.log((await text()).split('\n').filter(line => /archivo|fila|encabezado|histórico|identificador/i.test(line)));
   throw error;
 }
 console.log('Chromium: exportación Gantt XLSX con actividad sintética e importación histórica CSV confirmada en Firestore.');
 const swState=await evaluate('(async()=>{const result={secure:isSecureContext,available:!!navigator.serviceWorker};try{const reg=await navigator.serviceWorker.register("/sw.js");result.state=reg.active?.state??reg.installing?.state??reg.waiting?.state;result.scope=reg.scope;}catch(e){result.error=e.message;}return result})()');
 console.log('Diagnóstico worker:',JSON.stringify(swState));
 try { await until(()=>evaluate('!!navigator.serviceWorker.controller'),'Service Worker activo'); }
 catch(e){console.log('Registrations:',await evaluate('navigator.serviceWorker.getRegistrations().then(items=>items.map(r=>({scope:r.scope, active:r.active?.state, installing:r.installing?.state})))'));console.log('Cachés:',await evaluate('caches.keys()'));throw e;}

 assert.equal(await evaluate('caches.keys().then(keys=>keys.some(key=>key.startsWith("calera-shell-")))'),true);
 assert.equal(await evaluate('caches.open((await caches.keys())[0]).then(cache=>cache.keys())'.replace('caches.open((await caches.keys())[0]).then(cache=>cache.keys())','(async()=>{const key=(await caches.keys()).find(k=>k.startsWith("calera-shell-"));return (await (await caches.open(key)).keys()).some(r=>new URL(r.url).pathname.startsWith("/api/"));})()')),false);

 await click('bottom-nav-asistencia');
 await until(() => clickText('Global'), 'alcance global del formulario de asistencia');
 try {
   await until(async()=> (await text()).includes('Operario sintético'),'trabajador en asistencia');
 } catch (error) {
   console.log((await text()).split('\n').slice(-38));
   throw error;
 }
 await cmd('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await until(async()=> (await evaluate('navigator.onLine'))===false,'estado offline');
 assert.equal(await evaluate('document.querySelector("[data-testid=header-btn-user-menu]")?.tagName === "BUTTON"'), false);
 assert.ok(await evaluate('(() => { const button=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Asistió"); if(button)button.click(); return !!button; })()'));
 await until(()=>evaluate('JSON.parse(localStorage.getItem("calera_offline_pending_queue_v1")||"[]").some(o=>o.userId===' + JSON.stringify(uidFor('admin')) + '&&o.collectionName==="attendance")'),'asistencia en cola offline');
 await cmd('Page.reload');
 await until(()=>exists('login-screen'),'shell PWA recargada sin red');
 assert.equal(await exists('bottom-navigation-bar'),false);
 assert.equal(await evaluate('navigator.onLine'),false);
 await cmd('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await until(()=>exists('bottom-navigation-bar'),'restauración de sesión al reconectar');
 await until(async()=> (await db.collection('attendance').get()).docs.some(doc=>doc.get('records')?.['worker-smoke']==='Asistió'),'sincronización de asistencia tras recarga');
 console.log('PWA: worker activo, caché sin API, shell recargable offline y asistencia recuperada y sincronizada tras reconectar.');
 await click('bottom-nav-avance');
 await until(async()=> (await text()).includes('Control de Avance Diario de Obra'),'módulo para avance compartido');
 assert.ok(await evaluate('(() => {const b=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Registrar Parte de Hoy")&&!b.disabled);b?.click();return !!b})()'));
 const setField = (selector, value, kind, event) => setValue('.modal-viewport form ' + selector, value, kind, event);
 await until(()=>setField('select:has(option[value=a1])','a1','HTMLSelectElement','change'),'selección de actividad para avance');
 assert.ok(await setField('input[type=date]','2026-11-08','HTMLInputElement','input'));
 assert.ok(await setField('input[type=number][required]','2','HTMLInputElement','input'));
 assert.ok(await setField('input[type=number][placeholder]:not([required])','6','HTMLInputElement','input'));
 assert.ok(await evaluate('(() => {const f=[...document.querySelectorAll("form")].find(f=>f.textContent.includes("Guardar Avance"));const cb=f?.querySelector("label:has(input[type=checkbox]) input");cb?.click();return !!cb})()'));
 await until(()=>setField('select:has(option[value=barn-secondary])','barn-secondary','HTMLSelectElement','change'),'segundo galpón seleccionado');
 assert.ok(await evaluate(`(() => {
   const label = [...document.querySelectorAll('fieldset label')].find(item => item.textContent.includes('Operario sintético'));
   const input = label?.querySelector('input[type=checkbox]'); input?.click(); return !!input;
 })()`));
 await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:640,deviceScaleFactor:1,mobile:true});
 const modalBounds=await evaluate('(() => {const f=[...document.querySelectorAll("form")].find(f=>f.textContent.includes("Guardar Avance"));const overlay=f?.closest(".modal-viewport");const b=f?.querySelector("button[type=submit]");if(!b||!overlay)return null;const top=overlay.firstElementChild.getBoundingClientRect().top;b.scrollIntoView({block:"end"});const bottom=b.getBoundingClientRect().bottom;return {top,bottom,height:innerHeight}})()');
 assert.ok(modalBounds&&modalBounds.top>=0&&modalBounds.bottom<=modalBounds.height+1,JSON.stringify(modalBounds));
 await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 console.log('Chromium 390x640: encabezado visible y botón Guardar Avance alcanzable al desplazar el modal.');
 await cmd('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await until(async()=> (await evaluate('navigator.onLine'))===false,'desconexión para el avance');
 assert.ok(await evaluate('(() => {const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Guardar Avance");b?.click();return !!b})()'));
 try {
   await until(()=>evaluate('(() => {const parts=JSON.parse(localStorage.getItem("calera_offline_pending_queue_v1")||"[]").filter(x=>x.collectionName==="advances");return parts.length===2&&!!parts[0].writeGroupId&&parts[0].writeGroupId===parts[1].writeGroupId})()'),'dos partes offline en el mismo grupo');
 } catch(error){ console.log((await text()).split('\n').slice(-50));throw error; }
 assert.equal((await db.collection('advances').get()).size,0);
 await cmd('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await until(async()=> (await db.collection('advances').get()).size===2,'avance compartido confirmado');
 const parts=(await db.collection('advances').get()).docs.map(doc=>doc.data());
 assert.deepEqual(parts.map(item=>item.galponId).sort(),['barn-secondary','barn-smoke']);
 assert.equal(parts[0].sharedGroupId,parts[1].sharedGroupId);
 assert.deepEqual(parts.find(item=>item.galponId==='barn-smoke').workerIds,['worker-smoke']);
 assert.deepEqual(parts.find(item=>item.galponId==='barn-secondary').workerIds,[]);
 assert.equal((await db.doc('materials/stock-main').get()).get('usedQty'), 4);
 assert.equal((await db.doc('materials/stock-secondary').get()).get('usedQty'), 4);
 console.log('Chromium: dos partes de avance guardadas en un grupo offline y confirmadas juntas tras reconexión.');
 assert.ok(await clickText('+ Registrar Parte de Hoy'));
 await until(() => setField('select:has(option[value=a-pct])', 'a-pct', 'HTMLSelectElement', 'change'), 'actividad distinta con el mismo código');
 assert.ok(await setField('input[type=date]', '2026-11-09', 'HTMLInputElement', 'input'));
 assert.ok(await setField('input[type=number][required]', '37', 'HTMLInputElement', 'input'));
 assert.ok(await clickText('Guardar Avance'));
 try {
   await until(async () => (await db.collection('advances').where('activityId', '==', 'a-pct').get()).docs.some(doc =>
     doc.get('percentageReached') === 37 && doc.get('galponId') === 'barn-smoke'), 'porcentaje guardado en la actividad elegida por UID');
 } catch (error) {
   console.log((await text()).split('\n').slice(-38));
   console.log('Cola de avances:', await evaluate(`JSON.parse(localStorage.getItem('calera_offline_pending_queue_v1') || '[]')
     .filter(op => op.collectionName === 'advances').map(op => ({ state: op.status, error: op.errorCode, activity: op.payload?.activityId }))`));
   throw error;
 }
 await click('sidebar-link-informes');
 await until(async () => (await text()).includes('Personal, asistencia e inventario por galpón'), 'informe operativo');
 assert.ok(await setValue('input[placeholder="Buscar código, actividad, estructura..."]', 'Actividad en porcentaje'));
 await until(async () => (await text()).includes('Actividad en porcentaje'), 'búsqueda en informe');
 assert.ok(await clickText('Exportar resumen CSV'));
 await until(() => readdirSync(copy).find(name => /^Resumen_operativo_.*\.csv$/.test(name)), 'CSV de informe operativo');

 await db.doc('workers/legacy-browser').create({ id:'legacy-browser', name:'Operario legado', workerCode:{ invalid:true },
   dni:{ invalid:true }, role:'Montaje', active:true, sectorId:'sector-smoke', galponId:'barn-smoke' });
 await click('sidebar-link-personal');
 await until(async () => (await text()).includes('Operario legado'), 'Personal renderiza documento heredado');
 await click('bottom-nav-asistencia');
 await until(async () => (await text()).includes('Operario legado'), 'Asistencia renderiza documento heredado');
 await click('sidebar-link-personal');
 await until(() => evaluate(`(() => {const box = document.querySelector('input[aria-label="Operario activo Operario legado"]');
   if (!box || box.disabled) return false; box.click(); return true;})()`), 'marcar operario inactivo');
 await until(async () => (await db.doc('workers/legacy-browser').get()).get('active') === false, 'inactividad confirmada');
 await click('bottom-nav-asistencia');
 await until(async () => (await text()).includes('Operario sintético') && !(await text()).includes('Operario legado'),
   'Asistencia excluye al operario inactivo');
 await click('sidebar-link-personal');
 await until(() => clickText('Carga Masiva Excel/CSV'), 'abrir importación para XLSX inválido');
 const invalidWorkerFile = join(copy, 'invalid-worker.xlsx');
 const invalidWorkerBook = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(invalidWorkerBook, XLSX.utils.aoa_to_sheet([
   ['Codigo', 'DNI', 'Nombre', 'Especialidad', 'Cargo', 'Galpon'],
   ['REJECTED-XLSX', '9'.repeat(65), 'Fila inválida', 'Montaje', 'Operario', 'SMK-01']
 ]), 'Datos');
 writeFileSync(invalidWorkerFile, XLSX.write(invalidWorkerBook, { type: 'buffer', bookType: 'xlsx' }));
 await selectFile('input[accept=".xlsx,.xls,.csv"]', invalidWorkerFile);
 await until(async () => (await text()).includes('Campo dni inválido'), 'preview identifica el campo inválido del XLSX');
 assert.equal(await clickText('Importar 0 Fila(s) Válida(s)'), false);
 assert.ok(await clickText('Cancelar Importación'));

 async function importSheet(module, rows, expected = 1) {
   await click('sidebar-link-' + module);
   await until(() => clickText('Carga Masiva Excel/CSV'), 'abrir importación de ' + module);
   const fixture = join(copy, module + '-fixture.xlsx');
   const book = XLSX.utils.book_new();
   XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Datos');
   writeFileSync(fixture, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
   await selectFile('input[accept=".xlsx,.xls,.csv"]', fixture);
   await until(() => clickText('Importar ' + expected + ' Fila(s) Válida(s)'), 'confirmar importación de ' + module);
 }
 await click('sidebar-link-catalogo');
 await until(() => clickText('Carga Masiva Excel/CSV'), 'modal de catálogo para descargar plantilla');
 assert.ok(await clickText('Descargar plantilla Excel'));
 const templatePath = await until(() => readdirSync(copy).find(name => name === 'Plantilla_catalogo.xlsx'), 'plantilla Excel de catálogo');
 const template = XLSX.read(readFileSync(join(copy, templatePath)));
 const headers = XLSX.utils.sheet_to_json(template.Sheets.Plantilla, { header: 1 })[0];
 assert.ok(headers.includes('Modalidad'));
 const catalogRow = ['SYNTECH','CAT-ACEP','Obra Civil','Interno','','Pórtico','Actividad importada',10,'u',1,0,'Cantidades',8];
 const catalogBook = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(catalogBook, XLSX.utils.aoa_to_sheet([headers, catalogRow, catalogRow]), 'Datos');
 const catalogPath = join(copy, 'catalogo-fixture.xlsx');
 writeFileSync(catalogPath, XLSX.write(catalogBook, { type: 'buffer', bookType: 'xlsx' }));
 await selectFile('input[accept=".xlsx,.xls,.csv"]', catalogPath);
 await until(() => clickText('Importar 1 Fila(s) Válida(s)'), 'validación de una fila de catálogo y su duplicado');
 await until(async () => (await db.collection('masterCatalog').where('code', '==', 'CAT-ACEP').get()).docs.some(doc =>
   doc.get('durationDays') === 8), 'catálogo persistido con duración');
 assert.ok(await clickText('Exportar catálogo XLSX'));
 const catalogExportPath = await until(() => readdirSync(copy).find(file => file === 'Catalogo_actividades.xlsx'), 'exportación XLSX del catálogo');
 const catalogExport = XLSX.read(readFileSync(join(copy, catalogExportPath)));
 assert.ok(XLSX.utils.sheet_to_json(catalogExport.Sheets.Actividades).some(row => row.Codigo === 'CAT-ACEP' && row.DuracionDias === 8));
 await until(() => evaluate(`(() => {
   const row = [...document.querySelectorAll('tr')].find(item => [...item.cells].some(cell => cell.textContent.trim() === 'CAT-ACEP'));
   const button = row?.querySelector('button[title="Duplicar actividad maestra"]');
   button?.click(); return !!button;
 })()`), 'abrir copia de actividad individual');
 assert.equal(await evaluate(`document.querySelector('input[placeholder="Ej. JAU-001"]')?.value`), '');
 assert.ok(await setValue('input[placeholder="Ej. JAU-001"]', 'CAT-ACEP-DUP'));
 assert.ok(await clickText('Guardar en Catálogo'));
 const copiedActivity = await until(async () => (await db.collection('masterCatalog').where('code', '==', 'CAT-ACEP-DUP').get()).docs[0],
   'actividad individual guardada con código distinto');
 assert.equal(copiedActivity.get('durationDays'), 8);
 const originalActivity = (await db.collection('masterCatalog').where('code', '==', 'CAT-ACEP').get()).docs[0];
 assert.notEqual(copiedActivity.id, originalActivity.id);
 assert.equal(copiedActivity.get('name'), originalActivity.get('name'));
 assert.ok(await clickText('Gestionar Plantillas / Proveedores'));
 assert.ok(await setValue('input[placeholder="Nombre de nueva plantilla / proveedor..."]', 'SYNTECH COPIA'));
 assert.ok(await evaluate(`(() => {const button=document.querySelector('button[title="Duplicar plantilla SYNTECH"]');
   button?.click(); return !!button;})()`));
 await until(async () => (await db.collection('masterCatalog').where('technology', '==', 'SYNTECH COPIA').get()).docs.some(doc =>
   doc.get('code') === 'CAT-ACEP' && doc.get('durationDays') === 8), 'plantilla duplicada con actividad independiente');
 await until(() => clickText('Cerrar'), 'cerrar gestión de plantillas');

 await cmd('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await until(async () => (await evaluate('navigator.onLine')) === false, 'desconexión para la importación de Personal');
 await importSheet('personal', [
   ['Codigo', 'DNI', 'Nombre', 'Especialidad', 'Cargo', 'Galpon'],
   ['PER-ACEP', '90000111', 'Operario importado', 'Montaje', 'Operario', 'SMK-01'],
   ['PER-ACEP-2', '90000112', 'Segundo operario importado', 'Montaje', 'Operario', 'SMK-01']
 ], 2);
 const personalGroupId = await until(() => evaluate(`(() => {
   const group = JSON.parse(localStorage.getItem('calera_offline_pending_queue_v1') || '[]')
     .filter(op => op.collectionName === 'workers' && op.payload?.workerCode.startsWith('PER-ACEP'));
   return group.length === 2 && group.every(op => op.writeGroupId === group[0].writeGroupId) && group[0].writeGroupId;
 })()`), 'Personal encolado como un único lote');
 assert.equal((await db.collection('movements').where('importOperationId', '==', personalGroupId).get()).size, 0);
 await cmd('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await until(async () => {
   const ledger = await db.collection('movements').where('importOperationId', '==', personalGroupId).get();
   const workers = await db.collection('workers').where('workerCode', 'in', ['PER-ACEP', 'PER-ACEP-2']).get();
   return ledger.size === 2 && workers.size === 2 && workers.docs.every(doc => doc.get('galponId') === 'barn-smoke');
 }, 'lote XLSX completo confirmado con sus movimientos tras reconectar');
 await click('sidebar-link-actividades');
 assert.ok(await setValue('input[placeholder="Buscar código, estructura o actividad..."]', 'Actividad en porcentaje'));
 await until(async () => (await text()).includes('Actividad en porcentaje') && !(await text()).includes('Actividad sintética'),
   'búsqueda por actividad en gestión');

 await cmd('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await until(async () => (await evaluate('navigator.onLine')) === false, 'desconexión para el inventario');
 await importSheet('materiales', [
   ['Proveedor', 'Codigo', 'Material', 'Area', 'Sistema', 'Estructura', 'CantidadTotal', 'Unidad', 'Galpon'],
   ['SYNTECH', 'MAT-ACEP', 'Insumo importado offline', 'Obra Civil', '', 'Pórtico', 15, 'u', 'SMK-01']
 ]);
 const queueHasMaterial = () => evaluate(`JSON.parse(localStorage.getItem('calera_offline_pending_queue_v1') || '[]')
   .some(op => op.userId === ${JSON.stringify(uidFor('admin'))} && op.payload?.code === 'MAT-ACEP')`);
 await until(queueHasMaterial, 'inventario pendiente del autor original');
 await logout();
 await cmd('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await evaluate('location.hash="/dashboard"');
 await login('helper');
 await until(async()=> (await text()).includes('Control de Avance Diario de Obra'),'inicio en Avance para Auxiliar');
 assert.equal(await exists('bottom-nav-dashboard'),false);
 assert.equal(await exists('bottom-nav-gantt'),false);
 await evaluate('location.hash="/gantt"');
 await sleep(500);
 assert.equal(await exists('gantt-btn-export'),false);
 assert.equal(await exists('sidebar-link-movimientos'),true);
 assert.equal(await queueHasMaterial(), true);
 assert.equal((await db.collection('materials').where('code', '==', 'MAT-ACEP').get()).size, 0);
 await logout();
 await login('admin');
 await until(async () => (await db.collection('materials').where('code', '==', 'MAT-ACEP').get()).docs.some(doc =>
   doc.get('userId') === uidFor('admin') && doc.get('totalQty') === 15), 'inventario confirmado solo con el autor');
 console.log('Chromium: porcentaje por UID, plantilla y catálogo, personal, informe CSV e inventario offline aislado entre dos usuarios.');
 await click('sidebar-link-proyectos');
 await until(() => clickText('+ Nuevo Proyecto / Sector'), 'formulario de sector');
 const sectorForm = 'form:has(button[type=submit]):has(input[required])';
 assert.ok(await setValue(sectorForm + ' input[required]:nth-of-type(1)', 'Sector de aceptación'));
 assert.ok(await evaluate(`(() => {
   const form = [...document.forms].find(item => item.textContent.includes('Crear Sector'));
   const input = form?.querySelectorAll('input[required]')[1];
   if (!input) return false;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ACEP-BROWSER');
   input.dispatchEvent(new Event('input', { bubbles: true }));
   return true;
 })()`));
 assert.ok(await clickText('Crear Sector'));
 const acceptanceSector = await until(async () => (await db.collection('sectors').where('code', '==', 'ACEP-BROWSER').get()).docs[0]?.id,
   'sector creado desde el formulario');
 await until(() => clickText('+ Crear Galpón'), 'abrir alta de galpón');
 const barnForm = '.modal-viewport form ';
 assert.ok(await setValue(barnForm + 'select:has(option[value="' + acceptanceSector + '"])', acceptanceSector, 'HTMLSelectElement', 'change'));
 assert.ok(await evaluate(`(() => {
   const form = [...document.forms].find(item => [...item.querySelectorAll('button')].some(button => button.textContent.trim() === 'Crear Galpón'));
   const values = ['ACEP-GAL', 'Galpón de aceptación', 'Responsable libre, turno de prueba'];
   const input = form?.querySelectorAll('input[type=text]');
   if (!input || input.length < 3) return false;
   for (const [index, value] of values.entries()) {
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input[index], value);
     input[index].dispatchEvent(new Event('input', { bubbles: true }));
   }
   return true;
 })()`));
 assert.ok(await setValue(barnForm + 'select:has(option[value="SYNTECH COPIA"])', 'SYNTECH COPIA', 'HTMLSelectElement', 'change'));
 assert.ok(await clickText('Crear Galpón'));
 const savedBarn = await until(async () => (await db.doc('sectors/' + acceptanceSector).get()).get('galpones').find(barn => barn.code === 'ACEP-GAL'),
   'galpón creado desde plantilla');
 assert.equal(savedBarn.responsible, 'Responsable libre, turno de prueba');
 assert.ok(savedBarn.areas.some(area => (area.structures ?? []).some(structure => structure.activities.some(activity => activity.code === 'CAT-ACEP'))));
 console.log('Chromium: catálogo XLSX con duración, copia de una actividad y de una plantilla, y aplicación de plantilla al crear galpón.');
 await click('sidebar-link-movimientos');
 await until(() => setValue('select:has(option[value="Control de Materiales"])', 'Control de Materiales',
   'HTMLSelectElement', 'change'), 'filtro de módulo en bitácora');
 await until(async () => (await text()).includes('Importación sintética desde Chromium'), 'movimiento histórico visible con el filtro');
 assert.ok(await clickText('Exportar Bitácora (.CSV)'));
 const movementCsv = await until(() => readdirSync(copy).find(name => /^Historial_Movimientos_.*\.csv$/.test(name)), 'CSV de bitácora');
 const movementRows = readFileSync(join(copy, movementCsv), 'utf8');
 assert.match(movementRows, /"Proyecto","Sector","Galpón","Recurso","Operación"/);
 assert.ok(!movementRows.includes('"Planilla de Personal"'));
 await logout();
 const readsBeforeRestricted = operationalReads;
 await login('reader');
 await until(()=>exists('restricted-access'),'Solo lectura sin área operativa');
 assert.equal(await exists('bottom-navigation-bar'),false);
 await evaluate('location.hash="/materiales"');
 assert.equal(await exists('restricted-access'),true);
 await sleep(500);
 assert.equal(operationalReads, readsBeforeRestricted);
 console.log('Roles en Chromium: Auxiliar entra a Avance y hash a Gantt no monta la vista; Solo lectura queda restringido.');
 const views=[
   ['dashboard','Avance de proyectos y galpones','bottom-nav-dashboard'],['gantt',null,'bottom-nav-gantt'],
   ['avance_diario','Control de Avance Diario de Obra','bottom-nav-avance'],['asistencia','Control Diario de Asistencia','bottom-nav-asistencia'],
   ['proyectos','Gestión de Sectores y Galpones','sidebar-link-proyectos'],['catalogo','Catálogo Maestro de Actividades','sidebar-link-catalogo'],
   ['actividades','Gestión de Actividades del Galpón','sidebar-link-actividades'],['materiales','Catálogo y Control de Materiales','sidebar-link-materiales'],
   ['personal','Planilla Maestra de Personal','sidebar-link-personal'],['informes','Personal, asistencia e inventario por galpón','sidebar-link-informes'],
   ['movimientos','Historial de Movimientos de Usuarios','sidebar-link-movimientos']];
 for(const [name,blocked,ganttExport,ganttCreate] of [
   ['admin',[],true,true],['manager',[],true,true],['supervisor',[],false,true],['warehouse',[],false,false],
   ['helper',['dashboard','gantt','catalogo'],false,false]]){
   await logout();
   await evaluate('location.hash="/dashboard"');
   await login(name);
   await until(()=>exists('bottom-navigation-bar'),'sesión '+name);
   for(const [view,title,testId] of views){
     const allowed=!blocked.includes(view);
     assert.equal(await exists(testId),allowed,name+' '+view+' navegación');
     if(!allowed) continue;
     await click(testId);
     await until(async()=>title?(await text()).includes(title):await exists('gantt-module-view'),name+' '+view+' vista',25);
     assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'),true,name+' '+view+' desborde');
     if(view==='gantt'){
       assert.equal(await exists('gantt-btn-export'),ganttExport);
       assert.equal(await exists('gantt-btn-new-activity'),ganttCreate);
     }
   }
   console.log('Chromium '+name+': '+(views.length-blocked.length)+' módulos permitidos comprobados y controles de Gantt según rol.');
 }
 await logout();
 await evaluate('location.hash="/gantt"');
 await login('supervisor');
 await until(() => setValue('[data-testid=selector-sector-mobile]', 'sector-smoke', 'HTMLSelectElement', 'change'), 'sector del retiro');
 await until(() => evaluate(`document.querySelector('[data-testid="header-mobile-galpones-row"] button[title*="SMK-01"]')?.click(),
   document.body.innerText.includes('Galpón sintético')`), 'galpón del retiro');
 const ganttRow = 'tr:has(td[title="Actividad en porcentaje"])';
 await until(() => evaluate(`!!document.querySelector(${JSON.stringify(ganttRow)})`), 'actividad en Gantt antes del retiro');
 const history = async () => (await db.collection('advances').where('activityId', '==', 'a-pct').get()).docs.map(doc => doc.data());
 const beforeWithdrawal = await history();
 assert.ok(beforeWithdrawal.length);
 await cmd('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await until(async () => !(await evaluate('navigator.onLine')), 'Gantt sin conexión');
 assert.ok(await evaluate(`(() => {
   const button = [...document.querySelector(${JSON.stringify(ganttRow)}).querySelectorAll('button')]
     .find(item => item.textContent === 'Retirar del plan');
   if (!button) return false;
   button.click();
   return true;
 })()`));
 assert.ok(await clickText('Confirmar retiro del plan'));
 const queuedWithdrawal = () => evaluate(`JSON.parse(localStorage.getItem('calera_offline_pending_queue_v1') || '[]')
   .find(op => op.ganttWithdrawal === true && op.activityId === 'a-pct')`);
 const pendingWithdrawal = await until(queuedWithdrawal, 'retiro identificado persistido sin conexión');
 assert.equal(pendingWithdrawal.payload, undefined);
 const loginForApi = async name => {
   const response = await fetch('http://' + host + '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
     method: 'POST', headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ email: uidFor(name) + '@example.test', password, returnSecureToken: true })
   });
   assert.equal(response.status, 200);
   return (await response.json()).idToken;
 };
 const apiPost = (path, token, body) => fetch(origin + ':' + api.address().port + path, { method: 'POST',
   headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const sector = (await db.doc('sectors/sector-smoke').get()).data();
 const confirmedName = 'Sector actualizado en otra sesión';
 const changed = await apiPost('/api/data/write', await loginForApi('admin'), { writes: [{ collection: 'sectors', id: 'sector-smoke',
   requestId: randomUUID(), mode: 'merge', expectedRevision: sector._revision ?? 0, data: { name: confirmedName } }] });
 assert.equal(changed.status, 200);
 await cmd('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await until(async () => (await queuedWithdrawal())?.errorCode === 'STALE_DATA_VERSION', 'retiro conserva error de revisión');
 await cmd('Page.reload');
 await until(async () => (await text()).includes(confirmedName), 'recarga conserva nombre confirmado');
 await until(() => evaluate(`!!document.querySelector(${JSON.stringify(ganttRow)})`), 'la actividad rechazada sigue en Gantt');
 assert.equal((await queuedWithdrawal()).requestId, pendingWithdrawal.requestId);
 await click('connection-status-indicator');
 await until(() => clickText('Reenviar retiro sobre el plan vigente'), 'resolver retiro desde el Centro de Sincronización');
 try {
   await until(async () => (await db.doc('sectors/sector-smoke').get()).get('galpones')
     .find(barn => barn.id === 'barn-smoke')?.ganttExcludedActivityIds?.includes('a-pct'), 'retiro de Gantt confirmado por la API');
 } catch (error) {
   console.log('Cola de sectores:', await evaluate(`JSON.parse(localStorage.getItem('calera_offline_pending_queue_v1') || '[]')
     .filter(op => op.collectionName === 'sectors').map(({ documentId, status, errorCode, errorMessage }) => ({ documentId, status, errorCode, errorMessage }))`));
   throw error;
 }
 await until(() => evaluate(`!document.querySelector(${JSON.stringify(ganttRow)})`), 'Gantt oculta la actividad solo después de confirmar');
 const retry = await apiPost('/api/data/gantt/withdraw', await loginForApi('supervisor'), { sectorId: 'sector-smoke',
   galponId: 'barn-smoke', activityId: 'a-pct', requestId: pendingWithdrawal.requestId, expectedRevision: pendingWithdrawal.expectedRevision });
 assert.equal(retry.status, 200);
 assert.equal((await db.collection('movements').where('requestId', '==', pendingWithdrawal.requestId).get()).size, 1);
 await until(async () => !(await text()).includes('Centro de Sincronización Offline y Control Multiusuario') ||
   await clickText('Cerrar Panel'), 'cerrar el Centro de Sincronización');
 await click('bottom-nav-dashboard');
 await until(async () => (await text()).includes('Actividad en porcentaje'), 'actividad retirada visible en Dashboard');
 await click('sidebar-link-actividades');
 await until(async () => (await text()).includes('Actividad en porcentaje'), 'actividad retirada visible en Gestión de Actividades');
 await click('sidebar-link-informes');
 await until(async () => (await text()).includes('Actividad en porcentaje'), 'actividad retirada visible en Informes');
 assert.deepEqual(await history(), beforeWithdrawal);
 console.log('Chromium: 409, recarga, resolución del retiro con UUID original y conservación de Dashboard, Gestión de Actividades, Informes y avances.');
 const oldKey=await evaluate('caches.keys().then(keys=>keys.find(k=>k.startsWith("calera-shell-")))');
 assert.ok(oldKey);
 const workerPath=join(dist,'sw.js');
 const upgradedKey=oldKey+'-upgrade';
 writeFileSync(workerPath,readFileSync(workerPath,'utf8').replace(oldKey,upgradedKey),'utf8');
 await evaluate('navigator.serviceWorker.getRegistration().then(reg=>reg.update()).then(()=>true)');
 await until(()=>evaluate('navigator.serviceWorker.getRegistration().then(reg=>reg.waiting?.state==="installed")'),'worker nuevo en espera');
 await cmd('Page.navigate',{url:'about:blank'});
 await sleep(500);
 await cmd('Page.navigate',{url:testPage('dashboard')});
 await until(()=>evaluate('caches.keys().then(keys=>!keys.includes('+JSON.stringify(oldKey)+')&&keys.includes('+JSON.stringify(upgradedKey)+'))'),'activación del worker nuevo y limpieza del caché viejo');
 console.log('Chromium: actualización PWA esperó al cierre del cliente anterior y retiró el caché de la versión previa.');
 assert.deepEqual(pageExceptions, [], 'excepciones de JavaScript en navegación y operaciones');
} finally {
 ws?.close();
 if(chromium?.exitCode===null&&chromium.kill()) await once(chromium,'exit');
 if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
 await db?.terminate();
}
}, { ...process.env, VITE_API_BASE_URL: '', VITE_CALERA_AUTH_EMULATOR: 'http://' + host, VITE_CALERA_DEMO_PROJECT: project });
