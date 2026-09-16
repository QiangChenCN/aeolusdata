
/* 滚动逐条浮现（Apple 式）：卡片 / 首页盒子进入视口时上浮淡入。
   兼容：无 IntersectionObserver、prefers-reduced-motion、SPA 视图切换后新插入的卡片。 */
(function(){
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function showAll(){ document.querySelectorAll('.card,.home-box').forEach(function(el){ el.classList.add('in'); }); }
  if(reduce){ showAll(); return; }
  if(!('IntersectionObserver' in window)){ showAll(); return; }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold:0.08, rootMargin:'0px 0px -8% 0px' });
  function arm(){
    document.querySelectorAll('.card:not(.in),.home-box:not(.in)').forEach(function(el){
      if(el.dataset.revealArmed) return;
      el.dataset.revealArmed = '1';
      io.observe(el);
    });
  }
  arm();
  if('MutationObserver' in window){
    var main = document.querySelector('.main') || document.body;
    var mo = new MutationObserver(function(muts){
      var need = false;
      for(var i=0;i<muts.length && !need;i++){
        var nodes = muts[i].addedNodes;
        for(var j=0;j<nodes.length;j++){
          var node = nodes[j];
          if(node.nodeType !== 1) continue;
          if(node.matches && (node.matches('.card') || node.matches('.home-box'))){ need = true; break; }
          if(node.querySelectorAll && node.querySelectorAll('.card,.home-box').length){ need = true; break; }
        }
      }
      if(need) arm();
    });
    mo.observe(main, { childList:true, subtree:true });
  }
  window.addEventListener('load', arm);
  setTimeout(arm, 700);
})();

