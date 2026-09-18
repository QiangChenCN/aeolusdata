// 产物预览表格（xlsx/xls 渲染成可分页/可过滤的表格）。
// 本文件只会被 runs.js 按需 import()，因此 Tabulator 的 JS 与 CSS 都不会进入首屏主包——
// 主包 CSS 不再含 tabulator 主题，仅在用户打开「产物预览」时才加载此分块。
import "tabulator-tables/dist/css/tabulator_simple.min.css";
import { Tabulator } from "tabulator-tables";
import { esc } from "./ui.js";

export function toTabulatorData(headers, rows){
  var data = [], i, j, o;
  for(i=0;i<rows.length;i++){
    o = {};
    for(j=0;j<headers.length;j++){
      var v = rows[i][j];
      o["c"+j] = (v===undefined||v===null) ? "" : String(v);
    }
    data.push(o);
  }
  return data;
}
export function toTabulatorColumns(headers){
  return headers.map(function(h, idx){
    var t = (h===undefined||h===null||h==="") ? ("列"+(idx+1)) : String(h);
    return {
      title: t, field: "c"+idx, minWidth: 110, resizable: true,
      headerFilter: "input",
      formatter: function(cell){ return esc(cell.getValue()); }
    };
  });
}
// 仅负责真正建表；tabInit 守卫由 runs.js 的薄壳设置，避免重复初始化。
export function mountTabulator(hostId, headers, rows){
  var host = document.getElementById(hostId);
  if(!host || host.classList.contains("tabulator")) return;
  new Tabulator("#"+hostId, {
    data: toTabulatorData(headers, rows),
    columns: toTabulatorColumns(headers),
    layout: "fitColumns",
    height: "100%",
    virtualDom: false,
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [25, 50, 100, 200],
    movableColumns: true,
    tooltipsHeader: true,
    tooltips: function(cell){ var v = cell.getValue(); return (v && String(v).length>40) ? String(v) : false; },
    rowFormatter: function(row){
      var el = row.getElement();
      el.classList.remove("zebra");
      if(row.getPosition() % 2 === 1) el.classList.add("zebra");
    },
    placeholder: "（空表）"
  });
}
