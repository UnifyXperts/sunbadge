frappe.ui.form.on("Sales Invoice", {
shipping_address_name: async function (frm) {
	if (!frm.doc.shipping_address_name) {
		frm.set_value("custom_shipping_contact_person", "");
		frm.set_value("custom_shipping_contact_email", "");
		return;
	}

	try {

        const address = await frappe.db.get_doc(
			"Address",
			frm.doc.shipping_address_name
		);

		console.log("Selected Address:", address);

		const party_link = address.links?.find((link) =>
			["Customer", "Supplier"].includes(link.link_doctype)
		);


		const shipping_contacts = await frappe.db.get_list("Contact", {
			filters: {
				custom_is_shipping_contact: 1,
			},
			fields: [
				"name",
				"first_name",
				"last_name",
				"email_id",
				"phone",
				"mobile_no",
			],
		});



		for (const contact of shipping_contacts) {
			const contact_doc = await frappe.db.get_doc(
				"Contact",
				contact.name
			);

			const is_linked = contact_doc.links?.some(
				(link) =>
					link.link_doctype === party_link.link_doctype &&
					link.link_name === party_link.link_name
			);

			if (is_linked) {

				await frm.set_value(
					"custom_shipping_contact_person",
					contact_doc.name
				);

				await frm.set_value(
					"custom_shipping_contact_email",
					contact_doc.email_id || ""
				);


				return;
			}
		}


	} catch (error) {
		console.error("Error fetching Shipping Contact:", error);
	}
},
    
});

frappe.ui.form.on("Repairs Traveler Item", {
    repair_item_code(frm) {
        if(frm.doc.custom_is_repair){
        // frm.clear_table("items");

        let promises = [];

        (frm.doc.custom_repair_item_table || []).forEach(repair_row => {

            if (!repair_row.repair_item_code) return;

            promises.push(
                frappe.db.get_doc("Item", repair_row.repair_item_code).then(item => {

                    (item.custom_item_wise_services || []).forEach(service => {

                        let existing = frm.doc.items.find(
                            d => d.item_code === service.service_items
                        );

                        if (existing) {
                            existing.qty += repair_row.quantity || 1;
                        } else {
                            let so_item = frm.add_child("items");
                            so_item.item_code = service.service_items;
                            so_item.qty = repair_row.quantity || 1;

                            // Fetch Item description
                            frappe.db.get_value(
                                "Item",
                                service.service_items,
                                ["item_name", "description","stock_uom"],
                                (r) => {
                                    frappe.model.set_value(
                                        so_item.doctype,
                                        so_item.name,
                                        "item_name",
                                        r.item_name
                                    );
                            
                                    frappe.model.set_value(
                                        so_item.doctype,
                                        so_item.name,
                                        "description",
                                        r.description
                                    );
                                    frappe.model.set_value(
                                        so_item.doctype,
                                        so_item.name,
                                        "uom",
                                        r.stock_uom
                                    );
                                    
                                }
                            );
                        }
                    });
                })
            );
        });

        Promise.all(promises).then(() => {
            frm.refresh_field("items");
        });
    }
    }
});

async function get_item_and_set_service(frm, item_code) {

    try {

        const item = await frappe.db.get_doc("Item", item_code);


        if (!item.custom_item_wise_services || item.custom_item_wise_services.length === 0) {
            return false;
        }

        for (const service of item.custom_item_wise_services) {


            let existing = frm.doc.items.find(
                d => d.item_code === service.service_items
            );


            if (existing) {
                existing.qty += 1;
            } else {

                let so_item = frm.add_child("items");
                so_item.item_code = service.service_items;
                so_item.qty = 1;


                const r = await frappe.db.get_value(
                    "Item",
                    service.service_items,
                    ["item_name", "description", "stock_uom"]
                );


                if (!r.message) {
                    return false;
                }


                frappe.model.set_value(so_item.doctype, so_item.name, {
                    item_name: r.message.item_name,
                    description: r.message.description,
                    uom: r.message.stock_uom
                });

            }
        }


        frm.doc.items = frm.doc.items.filter(row => row.item_code);
        frm.refresh_field("items");

        return true;

    } catch (err) {

        return false;
    }
}


