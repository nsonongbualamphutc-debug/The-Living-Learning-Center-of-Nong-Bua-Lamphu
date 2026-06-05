/************************************************************
 * ศูนย์เรียนรู้ จังหวัดหนองบัวลำภู — Backend (เวอร์ชันปลอดภัย)
 *
 * ความปลอดภัยของ PIN:
 *  - เก็บเฉพาะ "ค่า hash" ของ PIN ในชีต ไม่เก็บ PIN จริง (อ่านย้อนไม่ได้)
 *  - ความลับ (PEPPER/SECRET) อยู่ใน Script Properties ไม่อยู่ในโค้ดหรือชีต
 *  - เข้าสู่ระบบ/บันทึก ผ่าน POST + token หมดอายุ 8 ชม. (PIN ไม่โผล่ใน URL)
 *  - สร้าง PIN จากในตัวแก้ไขเท่านั้น (เฉพาะเจ้าของบัญชีรันได้)
 *
 * ===== วิธีติดตั้ง (ทำครั้งเดียว ตามลำดับ) =====
 *  1) วางโค้ดนี้ทับของเดิม -> Save
 *  2) Run ฟังก์ชัน  setup        (สร้างชีต + ข้อมูล + คีย์ความปลอดภัย + เจน PIN)
 *  3) เปิดเมนู  ดู > บันทึกการดำเนินการ (Execution log)  จะเห็น PIN ของแต่ละศูนย์
 *       -> คัดลอกเก็บ แล้วแจกให้แต่ละอำเภอ (ระบบไม่เก็บ PIN จริงไว้ที่ไหนอีก)
 *  4) Deploy > Manage deployments > Edit (ดินสอ) > Version: New version
 *       Execute as: Me / Who has access: Anyone > Deploy
 *
 *  อยากเปลี่ยน PIN ใหม่ทั้งหมด -> Run  generateAllPins()  แล้วดู log
 *  เปลี่ยน PIN ศูนย์เดียว        -> Run  resetPin(2)  (ใส่ id ศูนย์) แล้วดู log
 ************************************************************/

var SHEETS = { centers: 'Centers', survey: 'Survey', log: 'Log' };

var CENTER_HEADERS = ['id','name','type','district','tambon','lat','lng','emoji','contact','phone',
  'pin','established','area','members','highlight','tags','products','bases','story','facebook','hours',
  'openDays','parking','toilet','food','stay','meeting','capacity','images','video',
  'visitors','trained','income','budget','support','updated'];

var SURVEY_HEADERS = ['timestamp','centerId','role','q_content','q_speaker','q_place','q_apply','q_overall','learned','improve'];
var LOG_HEADERS = ['timestamp','centerId','name','action','detail'];
var ASPECTS = ['q_content','q_speaker','q_place','q_apply','q_overall'];

/* ===================== Web app entry ===================== */
// GET = อ่านข้อมูลสาธารณะเท่านั้น (ไม่มีความลับใน URL)
function doGet(e){
  if (!e) e = {};
  if (!e.parameter) e.parameter = {};
  var out;
  try { out = routeGet(e.parameter); }
  catch (err) { out = { ok:false, error:String(err) }; }
  return reply(out, e.parameter.callback);
}
// POST = การกระทำที่ต้องยืนยันตัวตน (login/save/upload) PIN อยู่ใน body ไม่ใช่ URL
function doPost(e){
  var out;
  try {
    if (!e || !e.postData) throw 'ฟังก์ชันนี้ทำงานผ่าน Web app เท่านั้น';
    var d = JSON.parse(e.postData.contents);
    if (d.action === 'login')       out = apiLogin(d);
    else if (d.action === 'saveCenter') out = apiSave(d);
    else if (d.action === 'uploadImage') out = uploadImage(d);
    else out = { ok:false, error:'unknown action' };
  } catch (err) { out = { ok:false, error:String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function reply(obj, cb){
  var json = JSON.stringify(obj);
  if (cb) return ContentService.createTextOutput(cb + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function routeGet(p){
  var a = p.action || '';
  if (a === 'getAll')       return { ok:true, centers: readCenters(true) };
  if (a === 'getCenter')    return { ok:true, center: readCenters(true)[Number(p.id)] || null };
  if (a === 'submitSurvey') return submitSurvey(JSON.parse(p.data));
  if (a === 'surveyStats')  return { ok:true, stats: surveyStats(Number(p.id)) };
  if (a === 'recentLog')    return { ok:true, log: recentLog() };
  return { ok:true, msg:'ศูนย์เรียนรู้ หนองบัวลำภู API พร้อมใช้งาน (อ่าน: getAll, getCenter, surveyStats, recentLog | เข้าสู่ระบบ/บันทึก ใช้ POST)' };
}

/* ===================== Security ===================== */
function props(){ return PropertiesService.getScriptProperties(); }
function getPepper(){ var v = props().getProperty('PEPPER'); if (!v){ v = randStr(40); props().setProperty('PEPPER', v); } return v; }
function getSecret(){ var v = props().getProperty('SECRET'); if (!v){ v = randStr(56); props().setProperty('SECRET', v); } return v; }
function initSecurity(){ getPepper(); getSecret(); return 'คีย์ความปลอดภัยพร้อมแล้ว'; }
function randStr(n){ var c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; var s=''; for (var i=0;i<n;i++) s+=c.charAt(Math.floor(Math.random()*c.length)); return s; }

function hashPin(pin){
  var raw = getPepper() + '|' + String(pin);
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(d);
}
function b64url(bytes){ return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,''); }
function makeToken(id){
  var payload = id + '|' + (Date.now() + 8*3600*1000);   // หมดอายุ 8 ชม.
  var sig = Utilities.computeHmacSha256Signature(payload, getSecret());
  return b64url(Utilities.newBlob(payload).getBytes()) + '.' + b64url(sig);
}
function verifyToken(token){
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  var expect = b64url(Utilities.computeHmacSha256Signature(payload, getSecret()));
  if (expect !== parts[1]) return null;
  var seg = payload.split('|');
  if (Date.now() > Number(seg[1])) return null;
  return seg[0];   // คืนเป็น string: เลข id ของศูนย์ หรือ 'admin'
}
function checkPin(id, pin){
  var rows = sheetObjects(getSheet(SHEETS.centers, CENTER_HEADERS));
  for (var i=0;i<rows.length;i++){ if (Number(rows[i].id) === id) return String(rows[i].pin) === hashPin(pin); }
  return false;
}
function checkAdmin(pin){
  var h = props().getProperty('ADMIN_HASH');
  return !!h && h === hashPin(pin);
}

/* ===================== Auth APIs (POST) ===================== */
function apiLogin(d){
  if (String(d.id) === 'admin'){
    if (checkAdmin(String(d.pin))) return { ok:true, token: makeToken('admin'), role:'admin' };
    return { ok:false, error:'รหัสผู้ดูแลระบบไม่ถูกต้อง' };
  }
  if (!checkPin(Number(d.id), String(d.pin))) return { ok:false, error:'PIN ไม่ถูกต้อง' };
  return { ok:true, token: makeToken(Number(d.id)), role:'center' };
}
function apiSave(d){
  var who = verifyToken(d.token);
  if (who === null) return { ok:false, error:'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };
  if (who !== 'admin' && Number(who) !== Number(d.id)) return { ok:false, error:'ไม่มีสิทธิ์แก้ไขศูนย์นี้' };
  return writeCenter(Number(d.id), JSON.parse(d.data));
}

/* ===================== PIN generator (editor only) ===================== */
function generateAllPins(){
  initSecurity();
  var sh = getSheet(SHEETS.centers, CENTER_HEADERS);
  var v = sh.getDataRange().getValues(), h = v[0], pc = h.indexOf('pin'), ic = h.indexOf('id'), nc = h.indexOf('name');
  var out = [];
  for (var i=1;i<v.length;i++){
    if (v[i].join('') === '') continue;
    var pin = '' + Math.floor(100000 + Math.random()*900000);   // 6 หลัก
    v[i][pc] = hashPin(pin);
    out.push('ศูนย์ id=' + v[i][ic] + ' | ' + v[i][nc] + ' | PIN: ' + pin);
  }
  sh.getRange(1,1,v.length,h.length).setValues(v);
  Logger.log('================ PIN ใหม่ (คัดลอกแล้วแจกจ่าย) ================');
  out.forEach(function(x){ Logger.log(x); });
  Logger.log('ระบบเก็บเฉพาะ hash — ไม่เก็บ PIN จริงไว้ที่ใดอีก');
  return out.join('\n');
}
function resetPin(id){
  initSecurity();
  var sh = getSheet(SHEETS.centers, CENTER_HEADERS);
  var v = sh.getDataRange().getValues(), h = v[0], pc = h.indexOf('pin'), ic = h.indexOf('id');
  for (var i=1;i<v.length;i++){
    if (Number(v[i][ic]) === Number(id)){
      var pin = '' + Math.floor(100000 + Math.random()*900000);
      sh.getRange(i+1, pc+1).setValue(hashPin(pin));
      Logger.log('PIN ใหม่ของศูนย์ id=' + id + ' : ' + pin);
      return pin;
    }
  }
  return 'ไม่พบศูนย์ id=' + id;
}

/* PIN ผู้ดูแลระบบ — ใช้แก้ไขข้อมูลได้ทุกศูนย์ (เก็บเฉพาะ hash ใน Script Properties) */
function generateAdminPin(){
  initSecurity();
  var pin = '' + Math.floor(100000 + Math.random()*900000);
  props().setProperty('ADMIN_HASH', hashPin(pin));
  Logger.log('================ PIN ผู้ดูแลระบบ (จัดการได้ทุกศูนย์) ================');
  Logger.log('ADMIN PIN: ' + pin);
  return pin;
}
function setAdminPin(pin){
  initSecurity();
  props().setProperty('ADMIN_HASH', hashPin(String(pin)));
  Logger.log('ตั้ง PIN ผู้ดูแลระบบเป็น: ' + pin);
  return 'ตั้ง PIN ผู้ดูแลระบบเรียบร้อย';
}

/* ===================== Sheet helpers ===================== */
function getSheet(name, headers){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0){ sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
function sheetObjects(sh){
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var h = v[0], out = [];
  for (var i=1;i<v.length;i++){
    if (v[i].join('') === '') continue;
    var o = {}; for (var j=0;j<h.length;j++) o[h[j]] = v[i][j]; out.push(o);
  }
  return out;
}

/* ===================== Read centers (ไม่ส่ง pin/hash ออกไป) ===================== */
function readCenters(includeStats){
  var rows = sheetObjects(getSheet(SHEETS.centers, CENTER_HEADERS));
  var surveys = includeStats ? sheetObjects(getSheet(SHEETS.survey, SURVEY_HEADERS)) : [];
  return rows.map(function(r){
    var c = {
      id:Number(r.id), name:r.name, type:r.type, district:r.district, tambon:r.tambon,
      lat:Number(r.lat), lng:Number(r.lng), emoji:r.emoji || '🌾',
      contact:r.contact, phone:String(r.phone),
      established:r.established, area:r.area, members:r.members, highlight:r.highlight,
      tags:splitList(r.tags), products:splitList(r.products), bases:parseJSON(r.bases, []),
      story:String(r.story || '').split('|||').filter(String),
      facebook:r.facebook, hours:r.hours, openDays:r.openDays,
      amenities:{ parking:bool(r.parking), toilet:bool(r.toilet), food:bool(r.food), stay:bool(r.stay), meeting:bool(r.meeting) },
      capacity:Number(r.capacity) || 0, images:splitList(r.images), video:r.video || '',
      visitors:Number(r.visitors) || 0, trained:Number(r.trained) || 0,
      income:Number(r.income) || 0, budget:Number(r.budget) || 0,
      support:r.support || '', updated:r.updated || ''
    };
    if (includeStats){
      var st = aggregate(surveys.filter(function(s){ return Number(s.centerId) === c.id; }));
      c.satisfaction = st.overall; c.surveyCount = st.count; c.aspects = st.aspects;
    }
    return c;   // ไม่มี field pin ออกไปเด็ดขาด
  });
}

/* ===================== Write center (หลังยืนยัน token แล้ว) ===================== */
function writeCenter(id, data){
  var sh = getSheet(SHEETS.centers, CENTER_HEADERS);
  var v = sh.getDataRange().getValues(), h = v[0], idCol = h.indexOf('id');
  var editable = ['name','type','district','tambon','lat','lng','emoji','contact','phone',
    'established','area','members','highlight','tags','products','bases','story','facebook','hours',
    'openDays','parking','toilet','food','stay','meeting','capacity','images','video',
    'visitors','trained','income','budget','support'];   // ไม่รวม pin — แก้ผ่านนี้ไม่ได้
  for (var i=1;i<v.length;i++){
    if (Number(v[i][idCol]) === id){
      editable.forEach(function(k){ if (data[k] !== undefined){ var col=h.indexOf(k); if (col>-1) v[i][col]=data[k]; } });
      v[i][h.indexOf('updated')] = thaiDate();
      sh.getRange(i+1,1,1,h.length).setValues([v[i]]);
      appendLog(id, data.name || '', 'แก้ไขข้อมูลศูนย์');
      return { ok:true, msg:'บันทึกข้อมูลศูนย์เรียบร้อย' };
    }
  }
  return { ok:false, error:'ไม่พบรหัสศูนย์' };
}

/* ===================== Survey ===================== */
function submitSurvey(d){
  var cid = Number(d.centerId);
  if (!(cid >= 0)) return { ok:false, error:'centerId ไม่ถูกต้อง' };
  getSheet(SHEETS.survey, SURVEY_HEADERS).appendRow([ new Date(), cid, d.role || '',
    num(d.q_content), num(d.q_speaker), num(d.q_place), num(d.q_apply), num(d.q_overall),
    d.learned || '', d.improve || '' ]);
  return { ok:true, msg:'ขอบคุณสำหรับการประเมิน' };
}
function surveyStats(id){
  var rows = sheetObjects(getSheet(SHEETS.survey, SURVEY_HEADERS)).filter(function(s){ return Number(s.centerId) === id; });
  var agg = aggregate(rows);
  agg.learned = rows.map(function(r){ return r.learned; }).filter(String);
  agg.improve = rows.map(function(r){ return r.improve; }).filter(String);
  agg.byRole = { 'ผู้เข้าชม':rows.filter(function(r){return r.role==='ผู้เข้าชม';}).length,
                 'ผู้เข้าอบรม':rows.filter(function(r){return r.role==='ผู้เข้าอบรม';}).length };
  return agg;
}
function aggregate(rows){
  var aspects = {};
  ASPECTS.forEach(function(a){
    var vals = rows.map(function(r){ return Number(r[a]); }).filter(function(x){ return x>0; });
    aspects[a] = vals.length ? round1(vals.reduce(function(s,x){return s+x;},0)/vals.length) : 0;
  });
  return { count:rows.length, overall:aspects.q_overall, aspects:aspects };
}

/* ===================== Image upload (token) ===================== */
function uploadImage(d){
  var who = verifyToken(d.token);
  if (who === null) return { ok:false, error:'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };
  var fname = 'ศูนย์เรียนรู้-รูปภาพ';
  var it = DriveApp.getFoldersByName(fname);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(fname);
  var blob = Utilities.newBlob(Utilities.base64Decode(d.data), d.mime || 'image/jpeg', d.name || ('img_'+Date.now()+'.jpg'));
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok:true, url:'https://drive.google.com/uc?id=' + file.getId() };
}

/* ===================== Log ===================== */
function appendLog(centerId, name, action, detail){
  getSheet(SHEETS.log, LOG_HEADERS).appendRow([ new Date(), centerId, name, action, detail || '' ]);
}
function recentLog(){
  var rows = sheetObjects(getSheet(SHEETS.log, LOG_HEADERS));
  return rows.slice(-12).reverse().map(function(r){
    var t = (r.timestamp instanceof Date) ? Utilities.formatDate(r.timestamp,'Asia/Bangkok','dd/MM/yyyy HH:mm') : String(r.timestamp);
    return { time:t, name:r.name, action:r.action };
  });
}

/* ===================== Utils ===================== */
function splitList(s){ return String(s||'').split('|').map(function(x){return x.trim();}).filter(String); }
function parseJSON(s,f){ try{ return JSON.parse(s); }catch(e){ return f; } }
function bool(v){ return v===true || String(v).toUpperCase()==='TRUE' || v==='✓' || v===1; }
function num(v){ var n=Number(v); return n>0?n:''; }
function round1(x){ return Math.round(x*10)/10; }
function thaiDate(){ return Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy HH:mm'); }

/* ===================== One-time setup ===================== */
function setup(){
  initSecurity();
  getSheet(SHEETS.centers, CENTER_HEADERS);
  getSheet(SHEETS.survey, SURVEY_HEADERS);
  getSheet(SHEETS.log, LOG_HEADERS);
  var sh = getSheet(SHEETS.centers, CENTER_HEADERS);
  if (sh.getLastRow() <= 1){
    // pin เว้นว่างไว้ (ช่องที่ 11) — จะถูกเจนเป็น hash ทีหลัง ไม่มี PIN จริงในโค้ด
    var S = [
      [0,'กลุ่มปลูกผักอินทรีย์บ้านโพธิ์ศรีสำราญ','เกษตรอินทรีย์','เมืองหนองบัวลำภู','หัวนา',17.205,102.442,'🥬','นางประดับ สมณะ','081-0568544','','พ.ศ. 2554','8 ไร่','38 ราย','โครงการพระราชดำริ ปลูกผักอินทรีย์ ใช้พลังงานแสงอาทิตย์','ผักอินทรีย์|โซลาร์เซลล์|ลดสารเคมี','ผักสวนครัวอินทรีย์|พืชผักปลอดสารพิษ','[]','','','','ทุกวัน',true,true,false,false,false,50,'','',280,240,120000,0,'โรงเรือนผลิตผลทางการเกษตร',''],
      [1,'ศูนย์เรียนรู้ป่ารักษ์น้ำ','ปรัชญาเศรษฐกิจพอเพียง','นาวัง','นาเหล่า',17.452,102.302,'🌳','นางสาวพัชรินทร์ ศรีด้วง','065-3219730','','พ.ศ. 2541','5 ไร่','','โครงการพระราชดำริ อ่างเก็บน้ำซำปาคาด 6 ฐานเรียนรู้','6 ฐานเรียนรู้|ป่ารักษ์น้ำ|คนเอาถ่าน','ไม้ผล|ไม้ป่า|ถ่านชีวภาพ|สัตว์น้ำ','[]','','','','นัดหมายล่วงหน้า',true,true,true,false,true,100,'','',420,100,80000,200000,'',''],
      [2,'ศูนย์ ศพก. อำเภอสุวรรณคูหา','เกษตรผสมผสาน','สุวรรณคูหา','ดงมะไฟ',17.553,102.183,'🌾','นายมนวัฒน์ บุณยพรหม','084-3370262','','','24 ไร่','','ศพก. BCG Model เกษตรผสมผสาน 24 ไร่ แปรรูปข้าวยาง','ศพก.|BCG Model|ข้าวยาง|GAP','มะนาว|ทุเรียน|เงาะ|กล้วยน้ำว้า|ข้าวฮาง','[]','','','08:30-16:30','จ-ศ',true,true,true,false,true,100,'','',650,300,180000,12500,'โรงเรือนอัจฉริยะ',''],
      [3,'วิสาหกิจชุมชนแปลงใหญ่ข้าวอุทัยสวรรค์','วิสาหกิจชุมชน','นากลาง','อุทัยสวรรค์',17.322,102.312,'🍚','นางโสภา มุมวัน','086-2200224','','พ.ศ. 2565','615 ไร่','63 ราย','แปลงใหญ่ข้าว 615 ไร่ แบรนด์ข้าวบะออนซอน','แปลงใหญ่ข้าว|แบรนด์สินค้า|แปรรูปข้าว','ข้าว กข6|ข้าวดอกมะลิ 105|ข้าวฮาง','[]','','','','จ-ศ',true,true,false,false,true,80,'','',380,150,450000,0,'ชุดเครื่องยิงสี',''],
      [4,'ค่ายคนดีศรีบุญเรือง','ปรัชญาเศรษฐกิจพอเพียง','ศรีบุญเรือง','เมืองใหม่',16.972,102.272,'🏕️','นางสาวศิริพร เนธิบุตร','063-9013027','','','15 ไร่ 3 งาน','','บำบัดฟื้นฟูผู้ติดยา ฝึกวิชาชีพ เกษตรในค่าย','ฝึกอาชีพ|บำบัดฟื้นฟู|เกษตรในค่าย','เห็ด|ไก่|เป็ด|ผักสวนครัว','[]','','','','นัดหมายล่วงหน้า',true,true,true,true,true,60,'','',200,90,40000,10000,'',''],
      [5,'ศูนย์เรียนรู้โคกหนองโดนโมเดล','เกษตรผสมผสาน','โนนสัง','กุดดู่',17.002,102.572,'⛰️','นายเกรียงไกร ไทยอ่อน','081-9846526','','','1-3 ไร่','','โคก หนอง นา โมเดล จัดการน้ำ ปลูกพืช 5 ระดับ','โคกหนองนา|จัดการน้ำ|ปลูกป่า 3 อย่าง','ข้าว|ไก่กุดดู่หางขาว|ปลา|ป่า 3 อย่าง','[]','','','','นัดหมายล่วงหน้า',true,false,false,false,true,50,'','',340,120,95000,0,'พันธุ์ไก่พื้นบ้าน','']
    ];
    S.forEach(function(r){ r.push(thaiDate()); sh.appendRow(r); });
  }
  var pins = generateAllPins();   // เจน PIN รายศูนย์ + เก็บ hash + พิมพ์ลง log
  var adminPin = generateAdminPin();  // เจน PIN ผู้ดูแลระบบ (ทุกศูนย์)
  return 'ติดตั้งเสร็จ! เปิดดู Execution log เพื่อคัดลอก PIN\n\nPIN ผู้ดูแลระบบ (ทุกศูนย์): ' + adminPin + '\n\n' + pins;
}

/* ตรวจสอบ backend (ดูผลใน Execution log) */
function test_getAll(){
  var r = routeGet({ action:'getAll' });
  Logger.log('จำนวนศูนย์ที่อ่านได้: ' + (r.centers ? r.centers.length : 0));
}
