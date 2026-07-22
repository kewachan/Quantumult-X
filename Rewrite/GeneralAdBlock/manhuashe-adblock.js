let body = $response.body || "";
const url = $request.url || "";

if (!body || !/https?:\/\/comicapi\.manhuashe\.com\//i.test(url)) {
  $done({ body });
  return;
}

const setWelfareTabbar = (obj) => {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  let changed = false;
  if (obj.base && typeof obj.base === "object") {
    if (obj.base.welfare_tabbar_show !== 0) {
      obj.base.welfare_tabbar_show = 0;
      changed = true;
    }
  }
  return changed;
};

let changed = false;

try {
  const json = JSON.parse(body);
  const target = json.response && typeof json.response === "object" ? json.response : json;
  changed = setWelfareTabbar(target);
  body = JSON.stringify(json);
} catch (err) {
  if (/"welfare_tabbar_show"\s*:\s*\d+/i.test(body)) {
    body = body.replace(/("welfare_tabbar_show"\s*:\s*)\d+/gi, "$10");
    changed = true;
  } else if (/"base"\s*:\s*\{[^}]*\}/i.test(body)) {
    body = body.replace(/("base"\s*:\s*\{)/i, "$1\"welfare_tabbar_show\":0,");
    changed = true;
  }
}

if (!changed) {
  // keep raw body unchanged
}

$done({ body });
