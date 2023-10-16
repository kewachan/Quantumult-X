function ads_remove_attribute(tag, attribute, regex) {
    const nodelist = document.querySelectorAll(tag);
    for (i = 0; i < nodelist.length; i++) {
        let strings = nodelist[i].getAttribute(attribute);
        if (strings !== null) {
            if (strings.match(regex)) {
                nodelist[i].style.display = "none";
		console.log("清理完毕!");
            }
        }
    }
}

let regex = /^jnyxRd TpRPV$/g;
window.onload = ads_remove_attribute("div", "class", regex);

setTimeout (function() {
ads_remove_attribute("div", "class", regex);
} , 1000);

alert("your script run");
