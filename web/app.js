'use strict';
(() => {
  const $ = (selector) => document.querySelector(selector);
  const KEY = 'huihui-chat-v1';
  const API_BASE = String(window.HUIHUI_API_BASE || '').replace(/\/+$/, '');
  const ACCESS_KEY = 'huihui-chat-access-key';
  const apiUrl = (path) => `${API_BASE}${path}`;
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const defaults = {reasoning_effort:'fast',thinking_budget:8192,auto_compress:true,temperature:1,max_tokens:32768,system:'',theme:matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
  const state = {conversations:Array.isArray(saved.conversations) ? saved.conversations.filter(c=>c.id && Array.isArray(c.messages)) : [], active:saved.active || null, settings:{...defaults,...saved.settings}, generating:false,compressing:false,controller:null,config:{context_size:262144,max_output_tokens:65536,reasoning_budget_max:8192,compression_threshold:0.85},follow:true};
  if(!saved.settings?.reasoning_effort && saved.settings?.thinking)state.settings.reasoning_effort='deep';
  if(!['fast','light','balanced','deep'].includes(state.settings.reasoning_effort))state.settings.reasoning_effort='fast';
  state.settings.thinking_budget=Math.min(8192,Math.max(1024,Number(state.settings.thinking_budget)||8192));
  let renderTimer=null, lastRender=0;
  let scrollGuard=0, touchY=null;
  let toastTimer;
  document.documentElement.dataset.theme = state.settings.theme;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({conversations:state.conversations,active:state.active,settings:state.settings})); }
    catch (_) { toast('浏览器存储已满，部分对话暂时无法保存。'); }
  }
  function current() { return state.conversations.find(c=>c.id===state.active); }
  function toast(text) { $('#toast').textContent = text; $('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,2600); }
  function closeSidebar() { document.body.classList.remove('sidebar-open'); $('#sidebar-overlay').hidden=true; }
  function reasoningBudget(settings=state.settings) {return settings.reasoning_effort==='fast'?0:Math.min({light:2048,balanced:4096,deep:8192}[settings.reasoning_effort]||8192,Number(settings.thinking_budget)||8192,Number(state.config.reasoning_budget_max)||8192);}
  function syncThinking() {const mode=state.settings.reasoning_effort;for(const button of $('#effort-selector').children)button.setAttribute('aria-pressed',String(button.dataset.effort===mode));$('#setting-effort').value=mode;$('#setting-budget').value=state.settings.thinking_budget;const budget=reasoningBudget();$('#reasoning-budget-hint').textContent=budget?`思考 ≤ ${Math.round(budget/1024)}K`:'直接回答';}
  function updateComposer() {const busy=state.generating||state.compressing,b=$('#send-button');b.disabled=!busy&&!$('#prompt').value.trim();b.innerHTML=icon(busy?'stop':'arrow');b.title=busy?'停止生成':'发送消息';b.setAttribute('aria-label',b.title);document.body.dataset.generating=String(busy);updateContext();}
  function resizePrompt() { const t=$('#prompt');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,180)+'px';updateComposer(); }
  function scrollBottom(force=false) {if(force||state.follow){const area=$('#chat-scroll');scrollGuard=performance.now()+100;area.scrollTop=area.scrollHeight;}updateJumpButton();}
  function updateJumpButton() {const area=$('#chat-scroll');$('#jump-latest').hidden=area.scrollHeight-area.scrollTop-area.clientHeight<90;}
  function clearError() { $('#conversation-error').hidden=true;$('#conversation-error').textContent=''; }
  function showError(text) { $('#conversation-error').textContent=text;$('#conversation-error').hidden=false; }
  function renderHistory() {
    const list=$('#conversation-list');
    const items=[...state.conversations].sort((a,b)=>(b.updated||0)-(a.updated||0));
    list.innerHTML=items.length ? items.map(c=>`<div class="conversation-item ${c.id===state.active?'active':''}"><button class="conversation-select" data-conversation="${esc(c.id)}" title="${esc(c.title)}">${icon('message')}<span>${esc(c.title||'新对话')}</span></button><div class="conversation-actions"><button class="icon-button" data-rename="${esc(c.id)}" title="重命名对话" aria-label="重命名对话">${icon('edit')}</button><button class="icon-button" data-delete="${esc(c.id)}" title="删除对话" aria-label="删除对话">${icon('trash')}</button></div></div>`).join('') : '<p class="history-empty">你的对话会保存在此浏览器中。</p>';
  }
  function inline(text) {
    const codes=[];
    let safe=esc(text).replace(/`([^`\n]+)`/g,(_,s)=>{codes.push(`<code>${s}</code>`);return `\u0000${codes.length-1}\u0000`;});
    safe=safe.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    safe=safe.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_\n]+)__/g,'<strong>$1</strong>').replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g,'<em>$1</em>').replace(/~~([^~\n]+)~~/g,'<del>$1</del>');
    return safe.replace(/\u0000(\d+)\u0000/g,(_,i)=>codes[Number(i)]||'');
  }
  function prose(text) {
    const lines=text.replace(/\r\n/g,'\n').split('\n');let out='',p=[],list=null,quotes=[];
    const flushP=()=>{if(p.length){out+=`<p>${p.map(inline).join('<br>')}</p>`;p=[];}};
    const flushList=()=>{if(list){out+=`<${list.type}>${list.items.map(s=>`<li>${inline(s)}</li>`).join('')}</${list.type}>`;list=null;}};
    const flushQuotes=()=>{if(quotes.length){out+=`<blockquote>${quotes.map(inline).join('<br>')}</blockquote>`;quotes=[];}};
    for(let i=0;i<lines.length;i++){
      const line=lines[i], heading=line.match(/^(#{1,4})\s+(.*)$/), ul=line.match(/^\s*[-*+]\s+(.+)$/), ol=line.match(/^\s*\d+[.)]\s+(.+)$/),quote=line.match(/^>\s?(.*)$/);
      if(line.includes('|') && i+1<lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i+1])){
        flushP();flushList();flushQuotes();const cells=s=>s.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(v=>v.trim());const headers=cells(line);i++;const rows=[];while(i+1<lines.length && lines[i+1].includes('|') && lines[i+1].trim())rows.push(cells(lines[++i]));out+=`<div class="table-wrap"><table><thead><tr>${headers.map(s=>`<th>${inline(s)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(s=>`<td>${inline(s)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;continue;
      }
      if(!line.trim()){flushP();flushList();flushQuotes();continue;}
      if(heading){flushP();flushList();flushQuotes();out+=`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;continue;}
      if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){flushP();flushList();flushQuotes();out+='<hr>';continue;}
      if(quote){flushP();flushList();quotes.push(quote[1]);continue;}flushQuotes();
      if(ul||ol){flushP();const type=ul?'ul':'ol';if(list&&list.type!==type)flushList();if(!list)list={type,items:[]};list.items.push((ul||ol)[1]);continue;}
      flushList();p.push(line);
    }
    flushP();flushList();flushQuotes();return out;
  }
  function markdown(text) {
    text=String(text||'');
    // Fenced code may be incomplete while streaming. Treat the remaining tail as code.
    const re=/^\s*```([^\n]*)\n?/gm;let cursor=0,match,out='';
    while((match=re.exec(text))){out+=prose(text.slice(cursor,match.index));const language=match[1].trim();const start=re.lastIndex;const endRe=/^\s*```\s*$/gm;endRe.lastIndex=start;const end=endRe.exec(text);const finish=end?end.index:text.length;const code=text.slice(start,finish).replace(/\n$/,'');out+=`<div class="code-block"><div class="code-heading"><span>${esc(language||'code')}</span><button class="code-copy" type="button">${icon('copy')}复制代码</button></div><pre><code>${esc(code)}</code></pre></div>`;cursor=end?endRe.lastIndex:text.length;re.lastIndex=cursor;if(!end)break;}
    out+=prose(text.slice(cursor));return out;
  }
  function metrics(message) {
    const u=message.usage,t=message.timings,pieces=[];
    if(u?.completion_tokens)pieces.push(`${u.completion_tokens.toLocaleString()} tokens`);
    if(t?.predicted_per_second)pieces.push(`${Number(t.predicted_per_second).toFixed(1)} tokens/s`);
    if(message.stopped)pieces.push('已停止');
    return pieces.join(' · ');
  }
  function activeMessage(message,index) {return state.generating && index===(current()?.messages.length||0)-1;}
  function reasoningLabel(message,active) {return active&&!message.content?'思考中':'思考过程';}
  function thinkingHTML(message,active) {
    if(!message.reasoning)return '';
    const preview=message.reasoning.slice(-260).replace(/\s+/g,' ');
    return `<details class="thinking-block" ${message.thinkingOpen?'open':''}><summary><span class="thinking-title">${icon('spark')}<span class="thinking-label">${reasoningLabel(message,active)}</span></span><span class="thinking-preview" aria-hidden="true"><span class="thinking-preview-text">${esc(preview)}</span></span><span class="thinking-expand">${icon('chevron')}</span></summary><div class="thinking-text">${message.thinkingOpen?esc(message.reasoning):''}</div></details>`;
  }
  function answerHTML(message,active) {
    return message.content?markdown(message.content):active?`<span class="typing-indicator" aria-label="${state.compressing?'正在压缩上下文':'正在生成'}"><i></i><i></i><i></i></span>${state.compressing?'<span class="working-label">正在压缩上下文…</span>':''}`:message.error?`<p>${esc(message.error)}</p>`:'<p class="muted">生成已停止。</p>';
  }
  function actionsHTML(message,index,active) {
    const isLast=index===(current()?.messages.length||0)-1;
    return active?'':`<button class="icon-button" data-copy="${index}" title="复制回答" aria-label="复制回答">${icon('copy')}</button>${isLast?`<button class="icon-button" data-regenerate="${index}" title="重新生成" aria-label="重新生成">${icon('refresh')}</button>`:''}<span class="message-metrics">${esc(metrics(message))}</span>`;
  }
  function assistantBody(message,index) {
    const active=activeMessage(message,index);
    return `<div class="assistant-label">Huihui</div><div class="thinking-slot">${thinkingHTML(message,active)}</div><div class="message-content">${answerHTML(message,active)}</div><div class="message-actions" ${active?'hidden':''}>${actionsHTML(message,index,active)}</div>`;
  }
  function renderMessages(scroll=true) {
    const c=current(),messages=c?.messages||[],area=$('#chat-scroll'),position=area.scrollTop;
    $('#welcome').hidden=messages.length>0;
    $('#messages').innerHTML=messages.map((m,i)=>m.role==='user'?`<article class="message user"><div class="message-content">${esc(m.content)}</div></article>`:`<article class="message assistant" data-index="${i}"><div class="assistant-avatar" aria-hidden="true">H</div><div class="assistant-body">${assistantBody(m,i)}</div></article>`).join('');
    if(scroll){state.follow=true;scrollBottom(true);}else{area.scrollTop=position;updateJumpButton();}
    updateContext();scrollThinkingPreviews();
  }
  function scrollThinkingPreviews() {for(const el of document.querySelectorAll('.thinking-preview'))el.scrollLeft=el.scrollWidth;}
  function updateAssistant(message,index,complete=false) {
    const body=$(`#messages .message.assistant[data-index="${index}"] .assistant-body`);if(!body)return;
    const previousScrollTop=$('#chat-scroll').scrollTop;
    const active=activeMessage(message,index),slot=body.querySelector('.thinking-slot');
    if(message.reasoning){
      let details=slot.querySelector('details');
      if(!details){slot.innerHTML=thinkingHTML(message,active);details=slot.querySelector('details');}
      details.querySelector('.thinking-label').textContent=reasoningLabel(message,active);
      const preview=details.querySelector('.thinking-preview'),text=message.reasoning.slice(-260).replace(/\s+/g,' ');
      if(preview.firstElementChild.textContent!==text){preview.firstElementChild.textContent=text;preview.scrollLeft=preview.scrollWidth;}
      if(details.open){const full=details.querySelector('.thinking-text'),atBottom=full.scrollHeight-full.scrollTop-full.clientHeight<35;full.textContent=message.reasoning;if(atBottom&&active)full.scrollTop=full.scrollHeight;}
    }
    const content=body.querySelector('.message-content');
    const phase=state.compressing?'compressing':'generating';
    if(content.dataset.rendered!==message.content||content.dataset.phase!==phase||complete){content.innerHTML=answerHTML(message,active);content.dataset.rendered=message.content;content.dataset.phase=phase;}
    if(complete){const actions=body.querySelector('.message-actions');actions.hidden=false;actions.innerHTML=actionsHTML(message,index,false);$('#chat-scroll').scrollTop=previousScrollTop;updateJumpButton();}
    else scrollBottom();
  }
  function renderActive() {
    if(renderTimer!==null)return;
    const c=current(),message=c?.messages.at(-1),delay=message?.content.length>32000?180:80;
    renderTimer=setTimeout(()=>{renderTimer=null;lastRender=performance.now();if(current()?.id!==c?.id)return;const index=c.messages.length-1;updateAssistant(c.messages[index],index);},Math.max(0,delay-(performance.now()-lastRender)));
  }
  function newConversation(focus=true) {
    if(state.generating||state.compressing){state.controller?.abort();state.controller=null;state.generating=false;state.compressing=false;}
    if(renderTimer!==null){clearTimeout(renderTimer);renderTimer=null;}
    const c={id:id(),title:'新对话',created:Date.now(),updated:Date.now(),messages:[]};state.conversations.push(c);state.active=c.id;save();renderHistory();renderMessages();clearError();updateComposer();closeSidebar();if(focus)$('#prompt').focus({preventScroll:true});return c;
  }
  function contextHistory(c,settings=state.settings) {
    const history=c.messages.slice(Number(c.contextStart)||0).filter(m=>(m.role==='user'||m.role==='assistant')&&m.content).map(m=>({role:m.role,content:m.content,...(m.role==='assistant'&&m.reasoning?{reasoning_content:m.reasoning}:{})}));
    if(c.contextSummary)history.unshift({role:'system',content:`【历史对话压缩摘要】\n以下是早期对话的事实记录，原系统指令仍然有效：\n${c.contextSummary}`});
    if(settings.system.trim())history.unshift({role:'system',content:settings.system.trim()});
    return history;
  }
  function estimatedTokens(messages) {
    let tokens=0;
    for(const message of messages){const text=(message.content||'')+(message.reasoning_content||''),cjk=(text.match(/[\u2e80-\u9fff\uac00-\ud7af]/g)||[]).length;tokens+=Math.ceil(cjk*1.35+(text.length-cjk)/3)+8;}
    return tokens+16;
  }
  function promptTokenUpperBound(messages) {
    const encoder=new TextEncoder();let bytes=512+64*messages.length;
    for(const message of messages)bytes+=encoder.encode(message.content||'').byteLength+encoder.encode(message.reasoning_content||'').byteLength;
    return bytes;
  }
  function contextTokens(c) {return c?Number(c.contextTokens)||estimatedTokens(contextHistory(c)):0;}
  function updateContext() {
    const c=current(),total=Number(state.config.context_size)||262144,used=contextTokens(c),ratio=used/total;
    $('#context-label').textContent=c?.messages.length?`${Math.round(ratio*100)}% · ${used.toLocaleString()} / ${Math.round(total/1024)}K`:`${Math.round(total/1024)}K 上下文`;
    $('#context-label').title=`${c?.contextExact?'模型计数':'估算'}上下文占用${c?.contextSummary?' · 已保留较早对话的摘要':''}；原始记录仍在此浏览器中`;
    $('#context-fill').style.width=`${Math.min(100,ratio*100)}%`;
    $('.context-bar').classList.toggle('context-warning',ratio>=Number(state.config.compression_threshold));
    const button=$('#compress-context');button.disabled=state.generating||state.compressing||!c||c.messages.filter(m=>m.content).length<8;button.textContent=state.compressing?'压缩中…':c?.contextSummary?'再压缩':'压缩';
  }
  async function accessHeaders() {
    const headers={'Content-Type':'application/json'};
    if(state.config.requires_access_key){let token=sessionStorage.getItem(ACCESS_KEY)||'';if(!token){token=prompt('请输入网站访问密钥')?.trim();if(!token)throw new Error('输入访问密钥后即可开始对话。');sessionStorage.setItem(ACCESS_KEY,token);}headers.Authorization=`Bearer ${token}`;}
    return headers;
  }
  function parseError(text,status) {try{const data=JSON.parse(text);return data.error?.message||data.message||`请求失败（${status}）`;}catch(_){return text.slice(0,350)||`请求失败（${status}）`;}}
  async function jsonRequest(path,payload,headers,signal) {
    const response=await fetch(apiUrl(path),{method:'POST',headers,body:JSON.stringify(payload),signal});
    if(response.status===401&&state.config.requires_access_key)sessionStorage.removeItem(ACCESS_KEY);
    if(!response.ok)throw new Error(parseError(await response.text(),response.status));
    const data=await response.json();if(data.error)throw new Error(data.error.message||String(data.error));return data;
  }
  async function measureContext(c,headers,signal,settings=state.settings) {
    const messages=contextHistory(c,settings),contextSize=Number(state.config.context_size)||262144,threshold=(Number(state.config.compression_threshold)||0.85)*contextSize;
    // A byte-based upper bound keeps ordinary mobile turns to a single round trip.
    // Near the threshold, ask the model tokenizer before deciding whether to compress.
    if(promptTokenUpperBound(messages)<threshold&&Number(c.lastKnownContextTokens||0)<threshold){
      c.contextTokens=estimatedTokens(messages);c.contextExact=false;updateContext();
      return {prompt_tokens:c.contextTokens,context_size:contextSize,usage_ratio:c.contextTokens/contextSize,needs_compression:false};
    }
    const data=await jsonRequest('/api/context',{messages,reasoning_effort:settings.reasoning_effort,thinking_budget:reasoningBudget(settings)},headers,signal);
    c.contextTokens=Number(data.prompt_tokens)||0;c.lastKnownContextTokens=c.contextTokens;c.contextExact=true;if(data.context_size)state.config.context_size=data.context_size;updateContext();return data;
  }
  async function compress(c,headers,signal,settings=state.settings) {
    const source=contextHistory(c,settings),data=await jsonRequest('/api/compress',{messages:source,keep_last:6,reasoning_effort:settings.reasoning_effort,thinking_budget:reasoningBudget(settings)},headers,signal);
    if(!data.summary?.trim())throw new Error('压缩未返回摘要，原始对话已保留。');
    const contentIndices=c.messages.map((m,index)=>m.content&&(m.role==='user'||m.role==='assistant')?index:-1).filter(index=>index>=0),keptCount=(data.kept_messages||[]).filter(m=>m.role==='user'||m.role==='assistant').length||6;
    c.contextStart=contentIndices[Math.max(0,contentIndices.length-keptCount)]??c.messages.length;
    c.contextSummary=data.summary;c.contextTokens=Number(data.prompt_tokens)||estimatedTokens(contextHistory(c,settings));c.lastKnownContextTokens=c.contextTokens;c.contextExact=!!data.prompt_tokens;c.compressedAt=Date.now();save();updateContext();
    return data;
  }
  async function manualCompress() {
    const c=current();if(!c||state.generating||state.compressing)return;
    const settings={...state.settings},controller=new AbortController();state.controller=controller;state.compressing=true;clearError();updateComposer();
    try{const headers=await accessHeaders(),before=contextTokens(c),data=await compress(c,headers,controller.signal,settings);toast(`已压缩上下文：${(data.original_tokens||before).toLocaleString()} → ${contextTokens(c).toLocaleString()} tokens`);}
    catch(error){if(error.name==='AbortError')toast('已停止压缩，原始对话已保留');else showError(error.message||'压缩失败，原始对话已保留。');}
    finally{if(state.controller===controller){state.controller=null;state.compressing=false;}updateComposer();}
  }
  async function copyText(text) {try{await navigator.clipboard.writeText(text);toast('已复制');}catch(_){const temp=document.createElement('textarea');temp.value=text;temp.style.position='fixed';temp.style.opacity='0';document.body.appendChild(temp);temp.select();try{document.execCommand('copy');toast('已复制');}catch(_){toast('复制失败，请手动选择文本。');}temp.remove();}}
  async function generate(c) {
    const settings={...state.settings},answer={role:'assistant',content:'',reasoning:'',created:Date.now(),reasoning_effort:settings.reasoning_effort,thinking_budget:reasoningBudget(settings)};
    c.messages.push(answer);c.updated=Date.now();state.generating=true;const controller=new AbortController();state.controller=controller;state.follow=true;clearError();renderMessages();updateComposer();save();
    try{
      const headers=await accessHeaders();
      const usage=await measureContext(c,headers,controller.signal,settings);answer.prompt_tokens=c.contextTokens;
      if(settings.auto_compress&&(usage.needs_compression||usage.usage_ratio>=Number(state.config.compression_threshold))){
        state.compressing=true;updateComposer();updateAssistant(answer,c.messages.length-1);
        try{await compress(c,headers,controller.signal,settings);answer.prompt_tokens=c.contextTokens;toast('上下文已自动压缩，继续回答');}
        finally{if(state.controller===controller){state.compressing=false;updateComposer();}}
      }
      if(controller.signal.aborted)throw new DOMException('已停止','AbortError');
      const response=await fetch(apiUrl('/api/chat'),{method:'POST',headers,body:JSON.stringify({messages:contextHistory(c,settings),temperature:Number(settings.temperature),max_tokens:Number(settings.max_tokens),reasoning_effort:settings.reasoning_effort,thinking_budget:reasoningBudget(settings),thinking:settings.reasoning_effort!=='fast'}),signal:controller.signal});
      if(response.status===401&&state.config.requires_access_key){sessionStorage.removeItem(ACCESS_KEY);throw new Error('访问密钥无效，再次发送时会重新提示输入。');}
      if(!response.ok)throw new Error(parseError(await response.text(),response.status));
      const promptTokens=Number(response.headers.get('X-Prompt-Tokens'));if(promptTokens){c.contextTokens=promptTokens;c.lastKnownContextTokens=promptTokens;answer.prompt_tokens=promptTokens;c.contextExact=true;updateContext();}
      if(!response.body)throw new Error('浏览器不支持流式响应。');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',doneEvent=false;
      const consume=(block)=>{
        const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n').trim();if(!raw)return;if(raw==='[DONE]'){doneEvent=true;return;}
        let chunk;try{chunk=JSON.parse(raw);}catch(_){return;}
        if(chunk.error)throw new Error(chunk.error.message||String(chunk.error));
        const delta=chunk.choices?.[0]?.delta||chunk.choices?.[0]?.message||{};
        if(typeof delta.content==='string')answer.content+=delta.content;
        const reasoning=delta.reasoning_content??delta.reasoning;if(typeof reasoning==='string')answer.reasoning+=reasoning;
        if(chunk.usage)answer.usage=chunk.usage;if(chunk.timings)answer.timings=chunk.timings;
        const finish=chunk.choices?.[0]?.finish_reason;if(finish)answer.finish_reason=finish;
        renderActive();
      };
      while(true){const {value,done}=await reader.read();if(done){buffer+=decoder.decode();if(buffer.trim())consume(buffer.replace(/\r\n/g,'\n'));break;}buffer+=decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let split;while((split=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,split);buffer=buffer.slice(split+2);consume(block);}if(doneEvent){await reader.cancel();break;}}
      if(!answer.content&&!answer.reasoning)throw new Error('模型未返回内容，请重试。');
      if(answer.finish_reason==='length')toast('回答达到长度上限，可以发送“继续”');
    }catch(error){
      if(error.name==='AbortError'){answer.stopped=true;if(current()?.id===c.id)toast('已停止生成');}
      else{answer.error=error.message||'连接失败，请稍后重试。';if(current()?.id===c.id)showError(answer.error);}
    }finally{
      if(renderTimer!==null){clearTimeout(renderTimer);renderTimer=null;}
      const ownsController=state.controller===controller;
      if(ownsController){state.generating=false;state.compressing=false;state.controller=null;}
      if(answer.content||answer.reasoning){c.contextTokens=Number(answer.usage?.total_tokens)||(Number(answer.usage?.prompt_tokens)||Number(answer.prompt_tokens)||c.contextTokens||0)+(Number(answer.usage?.completion_tokens)||estimatedTokens([{content:answer.content,reasoning_content:answer.reasoning}]));c.lastKnownContextTokens=c.contextTokens;c.contextExact=!!answer.usage?.total_tokens;}
      c.updated=Date.now();save();renderHistory();
      if(current()?.id===c.id&&ownsController){updateAssistant(answer,c.messages.length-1,true);updateContext();}
      updateComposer();
    }
  }
  async function send() {
    if(state.generating||state.compressing){state.controller?.abort();return;}
    const content=$('#prompt').value.trim();if(!content)return;
    let c=current();if(!c)c=newConversation(false);
    if(!c.messages.some(m=>m.role==='user'))c.title=content.replace(/\s+/g,' ').slice(0,28)+(content.length>28?'…':'');
    c.messages.push({role:'user',content,created:Date.now()});c.lastKnownContextTokens=Number(c.contextTokens)||Number(c.lastKnownContextTokens)||0;c.contextTokens=0;c.contextExact=false;$('#prompt').value='';resizePrompt();renderHistory();await generate(c);
  }
  $('#composer-form').addEventListener('submit',event=>{event.preventDefault();send();});
  $('#prompt').addEventListener('input',resizePrompt);
  $('#prompt').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();if(!state.generating&&!state.compressing)send();}});
  const scrollArea=$('#chat-scroll');
  scrollArea.addEventListener('wheel',event=>{if(event.deltaY<0)state.follow=false;},{passive:true});
  scrollArea.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY??null;},{passive:true});
  scrollArea.addEventListener('touchmove',event=>{if(touchY!==null&&event.touches[0]?.clientY>touchY+3)state.follow=false;touchY=event.touches[0]?.clientY??null;},{passive:true});
  scrollArea.addEventListener('scroll',()=>{if(performance.now()>scrollGuard){const gap=scrollArea.scrollHeight-scrollArea.scrollTop-scrollArea.clientHeight;state.follow=gap<45;}updateJumpButton();},{passive:true});
  $('#jump-latest').addEventListener('click',()=>{state.follow=true;scrollBottom(true);});
  $('#compress-context').addEventListener('click',manualCompress);
  $('#new-chat').addEventListener('click',()=>newConversation());
  $('#sidebar-toggle').addEventListener('click',()=>{if(matchMedia('(max-width:680px)').matches){document.body.classList.toggle('sidebar-open');$('#sidebar-overlay').hidden=!document.body.classList.contains('sidebar-open');}else document.body.classList.toggle('sidebar-collapsed');});
  $('#sidebar-close').addEventListener('click',()=>{if(matchMedia('(max-width:680px)').matches)closeSidebar();else document.body.classList.add('sidebar-collapsed');});
  $('#sidebar-overlay').addEventListener('click',closeSidebar);
  $('#conversation-list').addEventListener('click',event=>{
    const select=event.target.closest('[data-conversation]'),rename=event.target.closest('[data-rename]'),remove=event.target.closest('[data-delete]');
    if(select){if(state.generating||state.compressing){toast('请先停止当前生成，再切换对话。');return;}state.active=select.dataset.conversation;save();renderHistory();renderMessages();clearError();closeSidebar();}
    if(rename){const c=state.conversations.find(x=>x.id===rename.dataset.rename);const title=prompt('对话名称',c.title);if(title?.trim()){c.title=title.trim().slice(0,120);save();renderHistory();}}
    if(remove){if((state.generating||state.compressing)&&state.active===remove.dataset.delete){toast('请先停止当前生成，再删除对话。');return;}if(!confirm('删除这个对话？此操作无法撤销。'))return;state.conversations=state.conversations.filter(x=>x.id!==remove.dataset.delete);if(state.active===remove.dataset.delete)state.active=state.conversations.at(-1)?.id||null;save();renderHistory();renderMessages();clearError();}
  });
  $('#messages').addEventListener('click',event=>{
    const copy=event.target.closest('[data-copy]'),regen=event.target.closest('[data-regenerate]'),code=event.target.closest('.code-copy');
    if(copy)copyText(current()?.messages[Number(copy.dataset.copy)]?.content||'');
    if(code)copyText(code.closest('.code-block').querySelector('code').textContent);
    if(regen&&!state.generating&&!state.compressing){const c=current();c.messages.splice(Number(regen.dataset.regenerate));c.lastKnownContextTokens=Number(c.contextTokens)||Number(c.lastKnownContextTokens)||0;c.contextTokens=0;generate(c);}
  });
  $('#messages').addEventListener('toggle',event=>{
    const details=event.target;if(!details.matches?.('.thinking-block'))return;
    const index=Number(details.closest('[data-index]')?.dataset.index),message=current()?.messages[index];if(!message)return;
    message.thinkingOpen=details.open;if(details.open){state.follow=false;details.querySelector('.thinking-text').textContent=message.reasoning;}else details.querySelector('.thinking-text').textContent='';
  },true);
  $('.suggestions').addEventListener('click',event=>{const button=event.target.closest('[data-prompt]');if(button){$('#prompt').value=button.dataset.prompt;resizePrompt();$('#prompt').focus({preventScroll:true});}});
  $('#effort-selector').addEventListener('click',event=>{const button=event.target.closest('[data-effort]');if(!button)return;state.settings.reasoning_effort=button.dataset.effort;syncThinking();save();});
  $('#theme-toggle').addEventListener('click',()=>{state.settings.theme=state.settings.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=state.settings.theme;save();});
  $('#settings-open').addEventListener('click',()=>{syncThinking();$('#setting-compress').checked=state.settings.auto_compress;$('#setting-temperature').value=state.settings.temperature;$('#temperature-value').textContent=Number(state.settings.temperature).toFixed(1);$('#setting-output').value=state.settings.max_tokens;$('#setting-system').value=state.settings.system;$('#settings-dialog').showModal();closeSidebar();});
  $('#setting-temperature').addEventListener('input',()=>$('#temperature-value').textContent=Number($('#setting-temperature').value).toFixed(1));
  $('#settings-save').addEventListener('click',()=>{state.settings.reasoning_effort=$('#setting-effort').value;state.settings.thinking_budget=Math.min(8192,Number($('#setting-budget').value));state.settings.auto_compress=$('#setting-compress').checked;state.settings.temperature=Number($('#setting-temperature').value);state.settings.max_tokens=Number($('#setting-output').value);state.settings.system=$('#setting-system').value;syncThinking();save();updateContext();toast('设置已保存');});
  $('#settings-dialog').addEventListener('click',event=>{if(event.target===$('#settings-dialog'))$('#settings-dialog').close();});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();newConversation();}if(event.key==='Escape')closeSidebar();});
  async function health() {try{const response=await fetch(apiUrl('/api/health'),{cache:'no-store'});const data=await response.json();const good=response.ok&&data.status!=='error'&&data.status!=='unavailable';$('#connection-status').className='connection-status '+(good?'online':'offline');$('.connection-text').textContent=good?'模型在线':'模型离线';}catch(_){$('#connection-status').className='connection-status offline';$('.connection-text').textContent='连接断开';}}
  fetch(apiUrl('/api/config')).then(r=>r.json()).then(config=>{state.config={...state.config,...config};if(config.max_output_tokens){for(const opt of $('#setting-output').options)opt.disabled=Number(opt.value)>config.max_output_tokens;state.settings.max_tokens=Math.min(state.settings.max_tokens,config.max_output_tokens);}state.settings.thinking_budget=Math.min(state.settings.thinking_budget,Number(state.config.reasoning_budget_max)||8192);const context=Math.round(state.config.context_size/1024)+'K';$('#model-subtitle').textContent=`Qwen3.8 27B · ${context}`;syncThinking();updateContext();save();}).catch(()=>{});
  function viewportChanged() {const viewport=window.visualViewport;if(!viewport)return;document.documentElement.style.setProperty('--app-height',`${viewport.height}px`);document.documentElement.style.setProperty('--app-offset',`${viewport.offsetTop}px`);updateJumpButton();}
  if(window.visualViewport){window.visualViewport.addEventListener('resize',viewportChanged);window.visualViewport.addEventListener('scroll',viewportChanged);viewportChanged();}
  if(window.ResizeObserver)new ResizeObserver(()=>document.documentElement.style.setProperty('--composer-height',`${$('.composer-area').getBoundingClientRect().height}px`)).observe($('.composer-area'));
  syncThinking();renderHistory();renderMessages();updateComposer();health();setInterval(health,30000);
})();
