import test from 'node:test';
import assert from 'node:assert/strict';
import { paneWidths, paneHeight, readLayout, LAYOUT_KEY, SPLITTER_SIZE } from '../web/layout.js';

test('oversized panes preserve at least 320px for work at desktop widths',()=>{
  for(const viewport of [901,1000,1100,1260,1600,2000]){
    const appWidth=viewport-34, layout=paneWidths(appWidth,viewport,{sidebar:100000,monitor:100000});
    assert.ok(layout.sidebar>=176&&layout.sidebar<=420);
    assert.ok(layout.monitor>=220&&layout.monitor<=520);
    assert.ok(appWidth-layout.sidebar-layout.monitor-SPLITTER_SIZE*2>=320);
  }
});
test('narrow layouts keep directory navigation and hide the inline monitor without overwriting preferences',()=>{
  const preferences={sidebar:330,monitor:460};
  const narrow=paneWidths(375,375,preferences);
  assert.equal(narrow.sidebar,64);assert.equal(narrow.sidebarVisible,false);assert.equal(narrow.monitorVisible,false);
  const middle=paneWidths(720,754,preferences);assert.equal(middle.sidebarVisible,true);assert.equal(middle.monitorVisible,false);
  const wide=paneWidths(1900,1934,preferences);assert.equal(wide.sidebar,330);assert.equal(wide.monitor,460);
  assert.deepEqual(preferences,{sidebar:330,monitor:460});
});
test('saved widths survive reload while malformed, nonnumeric and blocked storage falls back',()=>{
  const storage={getItem(key){assert.equal(key,LAYOUT_KEY);return JSON.stringify({version:1,sidebar:280,monitor:350});}};
  const restored=readLayout(storage);assert.deepEqual(restored,{sidebar:280,monitor:350});
  assert.equal(paneWidths(1400,1434,restored).sidebar,280);
  for(const value of ['{broken','null','{"version":9,"sidebar":280}','{"version":1,"sidebar":"280","monitor":-1}'])assert.deepEqual(readLayout({getItem:()=>value}),{});
  assert.deepEqual(readLayout({getItem(){throw Error('blocked');}}),{});
});
test('invalid widths cannot produce CSS NaN or infinity, and finite small values are clamped',()=>{
  const layout=paneWidths(1250,1284,{sidebar:NaN,monitor:Infinity});
  assert.equal(layout.sidebar,224);assert.equal(layout.monitor,290);
  const small=paneWidths(1250,1284,{sidebar:1,monitor:1});assert.equal(small.sidebar,176);assert.equal(small.monitor,220);
});

test('fractional viewport widths have no gap between inline and overlay modes',()=>{
  for(const viewport of [649.9,650,650.1,650.9,899.9,900,900.1,900.9,901]){
    const layout=paneWidths(viewport-34,viewport);
    assert.equal(layout.sidebarVisible,viewport>650);
    assert.equal(layout.monitorVisible,viewport>900);
    if(viewport>900){
      const large=paneWidths(viewport-34,viewport,{sidebar:10000,monitor:10000});
      assert.ok(viewport-34-large.sidebar-large.monitor-SPLITTER_SIZE*2>=320);
    }
  }
  // Media-query truth takes precedence over rounded window.innerWidth.
  const rounded=paneWidths(866.5,900,{}, {compact:false,monitorInline:true});
  assert.equal(rounded.monitorVisible,true);
});

test('monitor overlays can resize without reserving width in the main workspace',()=>{
  const preferences={sidebar:330,monitor:460};
  const mobile=paneWidths(375,375,preferences,{monitorOpen:true});
  assert.equal(mobile.monitorVisible,true);assert.equal(mobile.monitor,343);
  const middle=paneWidths(720,754,preferences,{monitorOpen:true});
  assert.equal(middle.sidebar,330);assert.equal(middle.monitor,460);
  assert.deepEqual(preferences,{sidebar:330,monitor:460});
});

test('all six pane sizes persist with backward compatibility and unknown keys ignored',()=>{
  const saved={version:1,sidebar:280,monitor:350,overview:240,composer:180,preview:220,directory:310,other:999};
  assert.deepEqual(readLayout({getItem:()=>JSON.stringify(saved)}),{sidebar:280,monitor:350,overview:240,composer:180,preview:220,directory:310});
  assert.deepEqual(readLayout({getItem:()=>'{"version":1,"overview":0,"composer":"180","preview":-3,"directory":null}'}),{});
});

test('vertical panes reserve neighbouring space and restore preferred heights after shrinking',()=>{
  for(const [minimum,reserved] of [[160,240],[112,72],[120,160],[90,100]]){
    const large=paneHeight(800,minimum,reserved,480,166);
    assert.equal(large.value,480);
    const small=paneHeight(350,minimum,reserved,480,166);
    assert.equal(small.value,350-reserved-SPLITTER_SIZE);
    assert.ok(small.value>=small.min&&small.value<=small.max);
    assert.equal(paneHeight(800,minimum,reserved,480,166).value,480);
    assert.deepEqual(paneHeight(0,minimum,reserved,480,166),{min:0,max:0,value:0});
  }
});

test('height reset uses intrinsic size and invalid saved values cannot corrupt layout',()=>{
  assert.equal(paneHeight(500,112,72,undefined,134).value,134);
  assert.equal(paneHeight(500,112,72,NaN,Infinity).value,112);
  assert.equal(paneHeight(500,112,72,1,134).value,112);
  assert.deepEqual(paneHeight(NaN,112,72,180,134),{min:0,max:0,value:0});
});
