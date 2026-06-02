import tempfile
import unittest
from pathlib import Path

from app.main import JobRequest, Prompt, run_build123d


BAD_BOX_FILLET_SOURCE = """
from build123d import Box, Axis


def gen_step():
    main_body = Box(60, 30, 12)
    vertical_edges = main_body.edges().filter_by(Axis.Z)
    main_body = main_body.fillet(6.0, vertical_edges)
    return main_body
"""


class Build123dRegressionTest(unittest.TestCase):
    def test_box_primitive_fillet_is_wrapped_before_step_export(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)
            job = JobRequest(
                jobId="box-fillet-regression",
                prompt=Prompt(text="make a hinged printable part"),
                source=BAD_BOX_FILLET_SOURCE,
            )

            run_build123d(job, job_dir)

            step_path = job_dir / "model.step"
            self.assertTrue(step_path.exists())
            self.assertGreater(step_path.stat().st_size, 0)
            self.assertIn(
                "main_body = Part(main_body).fillet(6.0, vertical_edges)",
                (job_dir / "source.py").read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
