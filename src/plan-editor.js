'use strict';
const { createHash, randomBytes } = require('node:crypto');

function planVersion(session) {
  return createHash('sha256').update(JSON.stringify([session.taskId,session.plan])).digest('hex');
}

function feedbackFor(plan, comments) {
  if(!Array.isArray(comments) || comments.length > plan.steps.length) return [];
  return comments.flatMap(item => {
    const index=item?.index;
    const text=typeof item?.text==='string' ? item.text.trim().slice(0,2000) : '';
    return Number.isInteger(index) && plan.steps[index] && text ?
      [{ title:plan.steps[index].title, text }] : [];
  });
}

function planEditorHtml() {
  const nonce=randomBytes(18).toString('base64');
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <style nonce="${nonce}">
    body{max-width:760px;margin:28px auto;padding:0 20px;font:var(--vscode-font-size) var(--vscode-font-family)}
    h1{font-size:1.6em;margin-bottom:12px} h2{font-size:1.15em;margin:24px 0 8px}
    li{padding:5px 0} textarea{display:block;width:100%;box-sizing:border-box;margin:6px 0 10px;padding:6px 8px;min-height:54px;resize:vertical;
      font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-widget-border))}
    header{display:flex;flex-wrap:wrap;gap:8px}
    button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid transparent;padding:5px 10px}
    #approve{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
    button:disabled{opacity:.55} :focus-visible{outline:1px solid var(--vscode-focusBorder)}
  </style>
  <header><button id="refresh" type="button">Обновить план</button><button id="feedback" type="button">Отправить комментарии</button><button id="approve" type="button">Одобрить и продолжить</button></header>
  <p id="status" role="status"></p><main id="plan"></main>
  <script nonce="${nonce}">
    const vscode=acquireVsCodeApi();
    const byId=id=>document.getElementById(id);
    let version, editable=false, allowApproval=false;
    function add(parent,tag,text){
      const item=document.createElement(tag);item.textContent=text;parent.append(item);return item;
    }
    function updateActions(){
      byId('feedback').disabled=!editable||![...document.querySelectorAll('textarea')].some(input=>input.value.trim());
      byId('approve').disabled=!allowApproval||!byId('feedback').disabled;
    }
    byId('refresh').onclick=()=>vscode.postMessage({type:'ready'});
    byId('feedback').onclick=()=>vscode.postMessage({type:'feedback',version,
      comments:[...document.querySelectorAll('textarea')].map(input=>({index:Number(input.dataset.index),text:input.value}))});
    byId('approve').onclick=()=>vscode.postMessage({type:'approve',version});
    window.addEventListener('message',({data})=>{
      if(data.type==='status'){byId('status').textContent=data.text;return;}
      if(data.type!=='plan')return;
      byId('status').textContent=data.status||'';
      editable=data.editable;allowApproval=data.allowApproval;
      if(version===data.version){updateActions();return;}
      version=data.version;const root=byId('plan');root.replaceChildren();
      const plan=data.plan;
      if(!plan){add(root,'p','В этой сессии пока нет сохранённого плана.');updateActions();return;}
      add(root,'h1',plan.goal);
      if(plan.decision)add(root,'p',plan.decision);
      add(root,'h2','Шаги');
      const list=add(root,'ol','');
      for(const [index,step] of plan.steps.entries()){
        const row=add(list,'li',(step.status==='done'?'✓ ':step.status==='running'?'● ':'')+step.title);
        if(editable){const input=add(row,'textarea','');input.dataset.index=index;input.maxLength=2000;
          input.setAttribute('aria-label','Комментарий к шагу '+(index+1));input.placeholder='Комментарий к шагу';input.oninput=updateActions;}
      }
      if(plan.acceptance?.length){
        add(root,'h2','Критерии приёмки');
        const criteria=add(root,'ul','');for(const item of plan.acceptance)add(criteria,'li',item);
      }
      updateActions();
    });
    updateActions();vscode.postMessage({type:'ready'});
  </script></html>`;
}

module.exports = {planVersion, feedbackFor, planEditorHtml};
