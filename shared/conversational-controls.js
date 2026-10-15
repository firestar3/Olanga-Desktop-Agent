/* Local conversation controls. Only a complete direct user request is matched. */
(function(root,factory){ const api=factory(); if(typeof module==='object'&&module.exports) module.exports=api; else root.OlangaConversationalControls=api; })(typeof globalThis!=='undefined'?globalThis:this,function(){
  function parse(input){
    if(typeof input!=='string'||input.length>1000||/[\r\n\x00-\x1f\[\]<>]/.test(input)) return null;
    const text=input.trim().replace(/[.!?]+$/,'').trim().replace(/^(?:please|could you|can you|would you)\s+/i,'');
    if(!text) return null;
    if(/^(?:run selected steps|yes[,]? run selected steps|start selected steps|confirm|resume workspace|resume selected workspace|save workspace|save selected setup)$/i.test(text))return{kind:'stale-review-confirm'};
    if(/^(?:cancel|cancel (?:the |my )?(?:request|routine|remaining steps|current request))$/i.test(text))return{kind:'cancel-request'};
    let m;
    if(/^(?:create|make|set up|add)(?: me)? (?:a |my )?(?:new )?routine(?: (?:called|named) (.+))?$/i.test(text)){
      m=/(?:called|named) (.+)$/i.exec(text);return m?named('routine-create',m[1]):{kind:'routine-create',name:''};
    }
    if(/^(?:open|show|take me to|go to)(?: the| my)? (?:routine(?:s| creator| editor| creation tab)|create routine(?: tab)?)$/i.test(text))return{kind:'routine-create',name:''};
    if((m=/^(?:run|start|execute) (?:the |my )?routine (.+)$/i.exec(text))||(m=/^(?:run|start|execute) (?:the |my )?(.+?) routine$/i.exec(text)))return named('routine-run',m[1]);
    if((m=/^(?:edit|change) (?:the |my )?routine (.+)$/i.exec(text))||(m=/^(?:edit|change) (?:the |my )?(.+?) routine$/i.exec(text)))return named('routine-edit',m[1]);
    if(/^(?:what (?:routines (?:do I have|have I saved)|are my routines)|(?:list|show|open) (?:my |the )?(?:saved )?routines)$/i.test(text))return{kind:'routine-list'};
    if(/^(?:(?:stop|pause|disable|turn off) (?:automatic )?(?:learning|learning about me|memory learning)|don['’]t learn (?:about me|from (?:our|my) conversations))$/i.test(text))return{kind:'learning-off'};
    if(/^(?:(?:start|resume|enable|turn on) (?:automatic )?(?:learning|learning about me|memory learning)|learn from (?:our|my) conversations)$/i.test(text))return{kind:'learning-on'};
    if(/^(?:undo (?:that |the last )?(?:memory|learned memory)|forget what you just learned|don['’]t remember that)$/i.test(text))return{kind:'learning-undo'};
    if(/^(?:what (?:have you (?:learned|remembered)(?: about me)?|do you (?:know|remember) about me)|(?:show|list|open) (?:my |your )?(?:saved |learned )?memor(?:ies|y))$/i.test(text))return{kind:'memory-list'};
    if(/^(?:what memor(?:y|ies) did you use|(?:show|explain) (?:the )?memor(?:y|ies) (?:you |that you )?used)$/i.test(text))return{kind:'memory-used'};
    if((m=/^(?:update|change|replace) (?:the |my )?memory ["“](.+?)["”] (?:with|to) ["“](.+?)["”]$/i.exec(text))){ const previous=name(m[1],300),text=name(m[2],300);return previous&&text?{kind:'memory-update',previous,text}:null; }
    if((m=/^(?:save|create) (?:a |my |the )?(?:new )?(?:workspace|work setup)(?: (?:called|named))? (.+)$/i.exec(text)))return named('workspace-save',m[1]);
    if((m=/^(?:resume|restore|open) (?:my |the )?(?:workspace|work setup) (.+)$/i.exec(text)))return named('workspace-resume',m[1]);
    if(/^(?:resume my work|(?:open|show|list) (?:my |the )?(?:saved )?workspaces)$/i.test(text))return{kind:'workspace-list'};
    if(/^(?:open|show|take me to) (?:the |my )?(?:backups?|backup center|personal backups?)$/i.test(text))return{kind:'backups'};
    if(/^(?:open|show|take me to|run) (?:the |my )?(?:health check|audio setup|microphone setup|voice setup|audio check)$/i.test(text))return{kind:'health'};
    if(/^(?:repeat|read|say) (?:the |your )?(?:last )?(?:result|answer|response)(?: again)?$/i.test(text))return{kind:'repeat-result'};
    if(/^(?:review|retry|resume) (?:the |my )?(?:unfinished|failed|remaining) steps$/i.test(text))return{kind:'unfinished-review'};
    return null;
  }
  function name(value,max=100){const text=String(value||'').trim().replace(/^["“]|["”]$/g,'').trim();return text.length&&text.length<=max&&!/[\[\]\r\n\x00-\x1f<>]/.test(text)?text:'';}
  function named(kind,value){const clean=name(value);return clean?{kind,name:clean}:null;}
  return{parse};
});
