let ele = '<body>';
let eleReplace = '<body><link rel="stylesheet" href="https://raw.githubusercontent.com/kewachan/Quantumult-X/main/CSS/css.css" type="text/css" /><script type="text/javascript" async="async" src="https://raw.githubusercontent.com/kewachan/Quantumult-X/main/JavaScript/googleadblock.js"></script>'
let body = $response.body.replace(ele, eleReplace) 
$done({ body }); 
