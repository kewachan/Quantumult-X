let ele = '<body>';
let eleReplace = '<body><script type="text/javascript" async="async" src="https://raw.githubusercontent.com/kewachan/Quantumult-X/main/JavaScript/googleadblock.js"></script>'
let body = $response.body.replace(ele, eleReplace) 
$done({ body }); 


