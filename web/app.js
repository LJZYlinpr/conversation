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
  const defaults = {thinking:false,temperature:1,max_tokens:32768,system:'',theme:matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
  const state = {conversations:Array.isArray(saved.conversations) ? saved.conversations.filter(c=>c.id && Array.isArray(c.messages)) : [], active:saved.active || null, settings:{...defaults,...saved.settings}, generating:false, controller:null, config:{context_size:262144,max_output_tokens:65536}, follow:true};
  let renderPending = false;
  let toastTimer;
  document.documentElement.dataset.theme = state.settings.theme;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({conversations:state.conversations,active:state.active,settings:state.settings})); }
    catch (_) { toast('浏览器存储已满，部分对话暂时无法保存。'); }
  }
  function current() { return state.conversations.find(c=>c.id===state.active); }
  function toast(text) { $('#toast').textContent = text; $('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,2600); }
  function closeSidebar() { document.body.classList.remove('sidebar-open'); $('#sidebar-overlay').hidden=true; }
  function syncThinking() { $('#thinking-shortcut').setAttribute('aria-pressed',String(state.settings.thinking));$('#setting-thinking').checked=state.settings.thinking; }
  function updateComposer() { const b=$('#send-button');b.disabled=!state.generating && !$('#prompt').value.trim();b.innerHTML=icon(state.generating?'stop':'arrow');b.title=state.generating?'停止生成':'发送消息';b.setAttribute('aria-label',b.title);document.body.dataset.generating=String(state.generating); }
  function resizePrompt() { const t=$('#prompt');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,180)+'px';updateComposer(); }
  function scrollBottom(force=false) { if(force || state.follow) {const area=$('#chat-scroll');area.scrollTop=area.scrollHeight;} }
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
    const u=message.usage,t=message.timings;const pieces=[];
    if(u?.completion_tokens)pieces.push(`${u.completion_tokens.toLocaleString()} tokens`);
    if(t?.predicted_per_second)pieces.push(`${Number(t.predicted_per_second).toFixed(1)} tokens/s`);
    return pieces.join(' · ');
  }
  function assistantBody(message,index) {
    const isLast=index===(current()?.messages.length||0)-1;
    const active=state.generating&&isLast;
    return `<div class="assistant-label">Huihui</div>${message.reasoning?`<details class="thinking-block" ${message.thinkingOpen?'open':''}><summary>${active&&!message.content?'正在思考…':'思考过程'}</summary><div class="thinking-text">${esc(message.reasoning)}</div></details>`:''}<div class="message-content">${message.content?markdown(message.content):active?'<span class="typing-indicator" aria-label="正在生成"><i></i><i></i><i></i></span>':message.error?`<p>${esc(message.error)}</p>`:'<p class="muted">生成已停止。</p>'}</div>${active?'':`<div class="message-actions"><button class="icon-button" data-copy="${index}" title="复制回答" aria-label="复制回答">${icon('copy')}</button>${isLast?`<button class="icon-button" data-regenerate="${index}" title="重新生成" aria-label="重新生成">${icon('refresh')}</button>`:''}<span class="message-metrics">${esc(metrics(message))}</span></div>`}`;
  }
  function renderMessages() {
    const c=current();const messages=c?.messages||[];
    $('#welcome').hidden=messages.length>0;
    $('#messages').innerHTML=messages.map((m,i)=>m.role==='user'?`<article class="message user"><div class="message-content">${esc(m.content)}</div></article>`:`<article class="message assistant" data-index="${i}"><div class="assistant-avatar" aria-hidden="true">H</div><div class="assistant-body">${assistantBody(m,i)}</div></article>`).join('');
    scrollBottom(true);
  }
  function renderActive() {
    if(renderPending)return;renderPending=true;
    requestAnimationFrame(()=>{renderPending=false;const c=current();if(!c)return;const index=c.messages.length-1;const body=$(`#messages .message.assistant[data-index="${index}"] .assistant-body`);if(body){const details=body.querySelector('details');if(details)c.messages[index].thinkingOpen=details.open;body.innerHTML=assistantBody(c.messages[index],index);}scrollBottom();});
  }
  function newConversation(focus=true) {
    if(state.generating){state.controller?.abort();state.controller=null;state.generating=false;}
    const c={id:id(),title:'新对话',created:Date.now(),updated:Date.now(),messages:[]};state.conversations.push(c);state.active=c.id;save();renderHistory();renderMessages();clearError();updateComposer();closeSidebar();if(focus)$('#prompt').focus();return c;
  }
  async function copyText(text) { try { await navigator.clipboard.writeText(text);toast('已复制'); } catch (_) {const temp=document.createElement('textarea');temp.value=text;temp.style.position='fixed';temp.style.opacity='0';document.body.appendChild(temp);temp.select();try{document.execCommand('copy');toast('已复制');}catch(_){toast('复制失败，请手动选择文本。');}temp.remove();} }
  function parseError(text,status) {try{const data=JSON.parse(text);return data.error?.message||data.message||`请求失败（${status}）`;}catch(_){return text.slice(0,350)||`请求失败（${status}）`;}}
  async function generate(c) {
    let accessToken='';
    if(state.config.requires_access_key){accessToken=sessionStorage.getItem(ACCESS_KEY)||'';if(!accessToken){accessToken=prompt('请输入网站访问密钥');if(!accessToken?.trim()){showError('输入访问密钥后即可开始对话。');return;}accessToken=accessToken.trim();sessionStorage.setItem(ACCESS_KEY,accessToken);}}
    const settings={...state.settings};const history=c.messages.filter(m=>(m.role==='user'||m.role==='assistant')&&m.content).map(m=>({role:m.role,content:m.content}));
    if(settings.system.trim())history.unshift({role:'system',content:settings.system.trim()});
    const answer={role:'assistant',content:'',reasoning:'',created:Date.now()};c.messages.push(answer);c.updated=Date.now();state.generating=true;const controller=new AbortController();state.controller=controller;state.follow=true;clearError();renderMessages();updateComposer();save();
    try {
      const headers={'Content-Type':'application/json'};if(accessToken)headers.Authorization=`Bearer ${accessToken}`;
      const response=await fetch(apiUrl('/api/chat'),{method:'POST',headers,body:JSON.stringify({messages:history,temperature:Number(settings.temperature),max_tokens:Number(settings.max_tokens),thinking:!!settings.thinking}),signal:controller.signal});
      if(response.status===401&&state.config.requires_access_key){sessionStorage.removeItem(ACCESS_KEY);throw new Error('访问密钥无效。再次发送或重新生成时会重新提示输入。');}
      if(!response.ok)throw new Error(parseError(await response.text(),response.status));
      const promptTokens=Number(response.headers.get('X-Prompt-Tokens'));if(promptTokens){$('.context-chip').textContent=`${promptTokens.toLocaleString()} / 256K`;$('.context-chip').title='本次请求的输入 tokens；发送完整对话历史。';}
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
      if(answer.finish_reason==='length')toast('回答达到长度上限，可让模型继续。');
    } catch(error) {
      if(error.name==='AbortError'){answer.stopped=true;toast('已停止生成');}
      else{answer.error=error.message||'连接失败，请稍后重试。';if(current()?.id===c.id)showError(answer.error);}
    } finally {
      if(state.controller===controller){state.generating=false;state.controller=null;}c.updated=Date.now();save();renderHistory();if(current()?.id===c.id)renderMessages();updateComposer();
    }
  }
  async function send() {
    if(state.generating){state.controller?.abort();return;}
    const content=$('#prompt').value.trim();if(!content)return;
    let c=current();if(!c)c=newConversation(false);
    if(!c.messages.some(m=>m.role==='user'))c.title=content.replace(/\s+/g,' ').slice(0,28)+(content.length>28?'…':'');
    c.messages.push({role:'user',content,created:Date.now()});$('#prompt').value='';resizePrompt();renderHistory();await generate(c);
  }
  $('#composer-form').addEventListener('submit',event=>{event.preventDefault();send();});
  $('#prompt').addEventListener('input',resizePrompt);
  $('#prompt').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!state.generating)send();}});
  $('#chat-scroll').addEventListener('scroll',()=>{const el=$('#chat-scroll');state.follow=el.scrollHeight-el.scrollTop-el.clientHeight<110;});
  $('#new-chat').addEventListener('click',()=>newConversation());
  $('#sidebar-toggle').addEventListener('click',()=>{if(matchMedia('(max-width:680px)').matches){document.body.classList.toggle('sidebar-open');$('#sidebar-overlay').hidden=!document.body.classList.contains('sidebar-open');}else document.body.classList.toggle('sidebar-collapsed');});
  $('#sidebar-close').addEventListener('click',()=>{if(matchMedia('(max-width:680px)').matches)closeSidebar();else document.body.classList.add('sidebar-collapsed');});
  $('#sidebar-overlay').addEventListener('click',closeSidebar);
  $('#conversation-list').addEventListener('click',event=>{
    const select=event.target.closest('[data-conversation]'),rename=event.target.closest('[data-rename]'),remove=event.target.closest('[data-delete]');
    if(select){if(state.generating){toast('请先停止当前生成，再切换对话。');return;}state.active=select.dataset.conversation;save();renderHistory();renderMessages();clearError();closeSidebar();}
    if(rename){const c=state.conversations.find(x=>x.id===rename.dataset.rename);const title=prompt('对话名称',c.title);if(title?.trim()){c.title=title.trim().slice(0,120);save();renderHistory();}}
    if(remove){if(state.generating&&state.active===remove.dataset.delete){toast('请先停止当前生成，再删除对话。');return;}if(!confirm('删除这个对话？此操作无法撤销。'))return;state.conversations=state.conversations.filter(x=>x.id!==remove.dataset.delete);if(state.active===remove.dataset.delete)state.active=state.conversations.at(-1)?.id||null;save();renderHistory();renderMessages();clearError();}
  });
  $('#messages').addEventListener('click',event=>{
    const copy=event.target.closest('[data-copy]'),regen=event.target.closest('[data-regenerate]'),code=event.target.closest('.code-copy');
    if(copy)copyText(current()?.messages[Number(copy.dataset.copy)]?.content||'');
    if(code)copyText(code.closest('.code-block').querySelector('code').textContent);
    if(regen&&!state.generating){const c=current();c.messages.splice(Number(regen.dataset.regenerate));generate(c);}
  });
  $('.suggestions').addEventListener('click',event=>{const button=event.target.closest('[data-prompt]');if(button){$('#prompt').value=button.dataset.prompt;resizePrompt();$('#prompt').focus();}});
  $('#thinking-shortcut').addEventListener('click',()=>{state.settings.thinking=!state.settings.thinking;syncThinking();save();});
  $('#theme-toggle').addEventListener('click',()=>{state.settings.theme=state.settings.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=state.settings.theme;save();});
  $('#settings-open').addEventListener('click',()=>{syncThinking();$('#setting-temperature').value=state.settings.temperature;$('#temperature-value').textContent=Number(state.settings.temperature).toFixed(1);$('#setting-output').value=state.settings.max_tokens;$('#setting-system').value=state.settings.system;$('#settings-dialog').showModal();closeSidebar();});
  $('#setting-temperature').addEventListener('input',()=>$('#temperature-value').textContent=Number($('#setting-temperature').value).toFixed(1));
  $('#settings-save').addEventListener('click',()=>{state.settings.thinking=$('#setting-thinking').checked;state.settings.temperature=Number($('#setting-temperature').value);state.settings.max_tokens=Number($('#setting-output').value);state.settings.system=$('#setting-system').value;syncThinking();save();toast('设置已保存');});
  $('#settings-dialog').addEventListener('click',event=>{if(event.target===$('#settings-dialog'))$('#settings-dialog').close();});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();newConversation();}if(event.key==='Escape')closeSidebar();});
  async function health() {try{const response=await fetch(apiUrl('/api/health'),{cache:'no-store'});const data=await response.json();const good=response.ok&&data.status!=='error'&&data.status!=='unavailable';$('#connection-status').className='connection-status '+(good?'online':'offline');$('.connection-text').textContent=good?'模型在线':'模型离线';}catch(_){$('#connection-status').className='connection-status offline';$('.connection-text').textContent='连接断开';}}
  fetch(apiUrl('/api/config')).then(r=>r.json()).then(config=>{state.config={...state.config,...config};if(config.max_output_tokens){for(const opt of $('#setting-output').options)opt.disabled=Number(opt.value)>config.max_output_tokens;state.settings.max_tokens=Math.min(state.settings.max_tokens,config.max_output_tokens);}if(config.context_size){const context=Math.round(config.context_size/1024)+'K';$('#model-subtitle').textContent=`Qwen3.8 27B · ${context}`;$('.context-chip').textContent=`${context} 上下文`;}save();}).catch(()=>{});
  syncThinking();renderHistory();renderMessages();updateComposer();health();setInterval(health,30000);
})();
