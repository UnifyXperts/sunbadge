frappe.ui.form.on("Lead", {
    refresh(frm) {
        setTimeout(() => {
            // Hide Prospect options
            $("a.dropdown-item").each(function () {
                const label = $(this).attr("data-label");

                if (
                    label === "Prospect" ||
                    label === "Add%20to%20Prospect"
                ) {
                    $(this).hide();
                }
            });

            // Hide Action button
            $(".page-actions button").filter(function () {
                return $(this).text().trim().startsWith("Action");
            }).hide();

        }, 300);
    }
});