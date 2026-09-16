// run.js —— 任务执行入口。
// 从 main.js 抽出：任务卡片的「运行」按钮在 config.js，而 runTasks 原定义在 main.js，
// 造成 config → main 的循环依赖。抽到本中立模块后，config.js 与 main.js 都不再互相依赖。
import { taskById, missingText } from "./store.js";
import { api } from "./api.js";
import { toast } from "./ui.js";
import { askConfirm } from "./behavior.js";
import { _sessionDangerOK } from "./task.js";
import { openRunModal } from "./runs.js";

export function runTasks(items){
  if(!items.length) return;
  // 校验必填
  for(var i=0;i<items.length;i++){
    var t = taskById(items[i].task_id);
    if(!t) continue;
    var ps = t.params || [];
    for(var j=0;j<ps.length;j++){
      if(ps[j].required){
        var v = (items[i].args||{})[ps[j].flag];
        if(v===undefined || v==="" || v===null){
          toast("「"+t.name+"」需要填写：" + ps[j].label);
          return;
        }
      }
    }
  }
  var risky = [], dangers = [];
  items.forEach(function(it){
    var t = taskById(it.task_id); if(!t) return;
    // 勾了 --reinit（即使任务本身 risk 是 caution）也升级到「高危操作确认」，
    // 因为 DROP 会真删全部已入库数据；warning 文本覆盖原 confirm。
    // 兜底逻辑：勾选那一刻已经弹过一次（_sessionDangerOK），这里就不再重复打扰；
    // 但如果开关是上次会话遗留的（刷新后仍勾着），这里仍然拦一道。
    var isDrop = (it.args || {})["--reinit"] === true && !_sessionDangerOK["--reinit"];
    if(isDrop || t.risk==="danger"){
      dangers.push({
        name: t.name,
        cmd: t.cmd,
        confirm: isDrop
          ? "DROP 重建表会清空全部已入库数据（表 ods_delivery_tracking 全部行）。\n运行后无法恢复，确认要执行？"
          : (t.confirm || ("将执行高危任务：" + t.name))
      });
    }else if(t.risk==="external") risky.push(t);
  });
  var go = function(){
    api("/api/run", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ items: items }) })
      .then(function(res){
        if(res && res.ok){
          toast("已加入执行队列（" + items.length + " 个）");
          if(res.run_ids && res.run_ids.length){
            // 队列顺序执行：弹窗锁定最后一个（最终停留在最后跑的任务），
            // run_start 到来时会逐一切到「当前正在跑」的任务，全程实时可见
            openRunModal(res.run_ids[res.run_ids.length - 1]);
          }
        }
        else toast("提交失败：" + ((res && res.error) || "未知错误"));
      })
      .catch(function(e){ toast("提交失败：" + e); });
  };
  /* 风控确认单独抽出来，好让「缺前置产物」的提示能串在它前面：
     先提示缺产物 → 确认后再走风控确认 → 最后才真正提交。 */
  var proceed = function(){
    if(dangers.length){
      askConfirm("高危操作确认",
        dangers.map(function(t){ return t.confirm || ("将执行高危任务：" + t.name); }).join(" "),
        "命令：" + dangers.map(function(t){ return t.cmd.join(" "); }).join(" | "), go);
    }else if(risky.length){
      askConfirm("这是会真实发到钉钉群的动作",
        risky.map(function(t){ return t.confirm || ("将执行：" + t.name); }).join(" "),
        "消息一旦发出无法撤回。如只是试跑，请勾选「不 @ 站长 / 只预览不发送」或改选测试群。", go);
    }else go();
  };
  /* 单任务直跑才检查前置产物：批量 / 流水线里前一步往往正是产出方，
     此时报缺失属于误报，所以只在 items 只有 1 个时提示。 */
  if(items.length === 1){
    var t0 = taskById(items[0].task_id);
    if(t0 && t0.missing && t0.missing.length){
      askConfirm("缺少前置产物",
        "「"+t0.name+"」依赖 "+missingText(t0.missing)+"，当前尚未生成。",
        "直接运行大概率失败。若产物会由其他步骤生成，可以忽略本提示继续。", proceed);
      return;
    }
  }
  proceed();
}
