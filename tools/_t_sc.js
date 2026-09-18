// 复刻站点数据 tab 渲染器逻辑，验证「分子/分母」合并列
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function _apNum(v){ return (v==null)?"—":v; }
function _apRateBadge(rate){
  if(rate===null||rate===undefined) return '<span class="ap-badge none">—</span>';
  var cls = rate>=100?"ok":(rate>=80?"warn":"bad");
  return '<span class="ap-badge '+cls+'">'+rate.toFixed(1)+'%</span>';
}
var _AP_STATION_CARDS = [
  {title:"时段有效", groups:[
    {k:"rate",label:"时段达成率",pct:true},
    {k:"achieved",label:"达标/目标",den:"target",numLabel:"时段达标人数",denLabel:"时段目标人数"}]},
  {title:"排班准确", groups:[
    {k:"rate",label:"时段达成率",pct:true},
    {k:"achieved",label:"达标/排班",den:"scheduled",numLabel:"时段达标人数",denLabel:"时段排班人数"}]},
  {title:"排班出勤", groups:[
    {k:"rate",label:"时段达成率",pct:true},
    {k:"order",label:"有单/排班",den:"scheduled",numLabel:"时段有单人数",denLabel:"时段排班人数"}]},
  {title:"时段满足", groups:[
    {k:"rate",label:"时段达成率",pct:true},
    {k:"order",label:"有单/目标",den:"target",numLabel:"时段有单人数",denLabel:"时段目标人数"}]}
];
function _apStationCard(card, periods, rows){
  var np = periods.length;
  var th1 = '<th rowspan="2" class="ap-col-id">站点ID</th><th rowspan="2" class="ap-col-name">站点名称</th>';
  var th2 = "";
  card.groups.forEach(function(g){
    var tip = g.den ? (' title="'+g.numLabel+' / '+g.denLabel+'"') : '';
    th1 += '<th colspan="'+np+'" class="ap-grp"'+tip+'>'+esc(g.label)+'</th>';
    periods.forEach(function(p){
      var ph = p.is_full_day ? '<span class="ap-fd">全天</span>' : esc(p.time_name||p.time_code);
      th2 += '<th class="ap-pcol">'+ph+'</th>';
    });
  });
  var trs = rows.map(function(r){
    var m = r.metrics||{};
    var tds = '<td class="ap-col-id">'+esc(r.team_id)+'</td><td class="ap-col-name">'+esc(r.team_name||r.team_id)+'</td>';
    card.groups.forEach(function(g){
      periods.forEach(function(p){
        var cell = m[p.time_code]||{};
        var v = cell[g.k];
        if(g.pct){ tds += '<td class="center">'+_apRateBadge(v)+'</td>'; }
        else if(g.den){
          var den = cell[g.den];
          if(v==null||den==null){ tds += '<td class="ap-combo">—</td>'; }
          else {
            var tip = ' title="'+g.numLabel+' '+v+' / '+g.denLabel+' '+den+'"';
            tds += '<td class="ap-combo"'+tip+'><span class="ap-cn">'+v+'</span><span class="ap-slash">/</span><span class="ap-cd">'+den+'</span></td>';
          }
        }
        else { tds += '<td class="num">'+_apNum(v)+'</td>'; }
      });
    });
    return '<tr>'+tds+'</tr>';
  }).join("");
  var cols = '<col style="width:56px"><col style="width:150px">';
  card.groups.forEach(function(g){
    periods.forEach(function(p){ cols += '<col style="width:50px">'; });
  });
  return {html:'<div class="ap-station-card"><div class="ap-station-card-h">'+esc(card.title)+'</div>'+
    '<div class="ap-table-wrap"><table class="ap-table ap-station-table"><colgroup>'+cols+'</colgroup>'+
    '<thead><tr>'+th1+'</tr><tr>'+th2+'</tr></thead><tbody>'+trs+'</tbody></table></div></div>',
    cols:cols};
}
// 模拟数据：9 个时段（含全天）
var periods=[{time_code:"9999",time_name:"全天",is_full_day:true},
  {time_code:"100",time_name:"凌晨1"},{time_code:"111",time_name:"早餐1"},
  {time_code:"122",time_name:"早餐2"},{time_code:"140",time_name:"午高峰"},
  {time_code:"160",time_name:"下午茶"},{time_code:"180",time_name:"晚高峰"},
  {time_code:"200",time_name:"夜宵1"},{time_code:"220",time_name:"夜宵2"}];
// 黄江站，凌晨1 达成率 60%，达标6 目标4 → 期望 "6/4"
var rows=[{team_id:"1",team_name:"黄江镇站",metrics:{
  "9999":{rate:14.6,target:48,achieved:7,scheduled:49,order:30},
  "100":{rate:60,target:4,achieved:6,scheduled:5,order:3}
}}];
var out=_apStationCard(_AP_STATION_CARDS[0], periods, rows);
var colCount=(out.html.match(/<col /g)||[]).length;
console.log("=== 时段有效 卡片 ===");
console.log("列数(2 sticky + 2组×9时段 =",2+2*periods.length,"):", colCount, colCount===2+2*periods.length?"OK":"FAIL");
console.log("含达标率徽章:", out.html.indexOf("ap-badge")>=0);
console.log("含合并列 ap-combo:", out.html.indexOf("ap-combo")>=0);
console.log("凌晨1 合并列 6/4 片段:", out.html.indexOf('<span class="ap-cn">6</span><span class="ap-slash">/</span><span class="ap-cd">4</span>')>=0 ? "OK (6/4)" : "FAIL");
console.log("合并列 title 提示:", out.html.indexOf('title="时段达标人数 6 / 时段目标人数 4"')>=0 ? "OK" : "FAIL");
console.log("全天列无重复(全天 只一次 ap-fd):", (out.html.match(/ap-fd">全天/g)||[]).length, "(期望 9 个时段各1次表头)");
// 全部 4 卡片结构校验
var allOK=true;
_AP_STATION_CARDS.forEach(function(c){
  var o=_apStationCard(c, periods, rows);
  var cc=(o.html.match(/<col /g)||[]).length;
  if(cc!==2+2*periods.length) allOK=false;
  if(o.html.indexOf("ap-combo")<0) allOK=false;
});
console.log("=== 4 卡片均 2组×np 列 + 含合并列:", allOK?"OK":"FAIL");
