function ads_remove_attribute(tag, attribute, regex) {
    const nodelist = document.querySelectorAll(tag);
    for (i = 0; i < nodelist.length; i++) {
        let strings = nodelist[i].getAttribute(attribute);
        if (strings !== null) {
            if (strings.match(regex)) {
                nodelist[i].style.display = "none";
            }
        }
    }
}

let regex = /^jnyxRd TpRPV$/g;
ads_remove_attribute("div", "class", regex)
