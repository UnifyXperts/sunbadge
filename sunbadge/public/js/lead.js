frappe.ui.form.on("Lead", {
	refresh(frm) {
		// Hide "Prospect" option from Create menu
		setTimeout(() => {
			$("a.dropdown-item").each(function () {
				let text = $(this).text().trim();

				if (text === "Prospect") {
					$(this).hide();
				}
			});
		}, 300);
	}
});